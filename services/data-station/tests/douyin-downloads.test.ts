import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DataRepository } from '../src/server/repository.ts';
import { createApp } from '../src/server/app.ts';
import { resolveConfig } from '../src/server/config.ts';
import { createTosObjectStore, DouyinDownloadError, DouyinDownloadManager, downloadVideo, publicObjectUrl, readTosCredentials, type ObjectStore } from '../src/server/douyin-downloads.ts';
import { DouyinSearchError } from '../src/server/douyin-search.ts';
import type { UserIdentity } from '../src/shared/types.ts';
import { createServiceIdentity } from '../src/server/hits/service-auth.ts';
import { createMuseAccountTokenIdentity, type MuseAccount } from '../src/server/identity.ts';
import type { DouyinDownloadRequestResult, DouyinDownloadStatus } from '../src/shared/douyin-downloads.ts';

const T0 = Date.parse('2026-11-15T08:00:00.000Z'); // 16:00 Beijing
const member: UserIdentity = { id: 'm1', name: '成员甲', role: 'member' };
const admin: UserIdentity = { id: 'a1', name: '管理员', role: 'admin' };
const secret = 'S3cretValueThatMustNeverAppear0123456789';

function post(id: string, episode: number | null, mixId: string | null = '7529749968874113060') {
  return { content_id: id, title: `第${episode ?? 1}集 林默觉醒`, description: '', web_url: `https://www.douyin.com/video/${id}`,
    author: { nickname: '作者' }, stats: {}, media: { covers: [], video: { url: `https://v26.douyinvod.com/${id}.mp4?x=1`, urls: ['https://127.0.0.1/evil.mp4', `https://v3.douyinvod.com/${id}.mp4`] } },
    raw: mixId ? { mix_info: { mix_id: mixId, mix_name: '鉴宝天骄', statis: { current_episode: episode, updated_to_episode: 3 } } } : {} };
}

class FakeStore implements ObjectStore {
  objects = new Map<string, { bytes: number; sha256: string | null }>();
  uploads: string[] = [];
  corrupt = false;
  async head(key: string) { return this.objects.get(key) ?? null; }
  async upload(key: string, path: string, sha256: string) {
    const bytes = await readFile(path);
    this.uploads.push(key);
    this.objects.set(key, { bytes: bytes.byteLength + (this.corrupt ? 1 : 0), sha256 });
  }
  link(key: string, seconds: number) { return `https://signed.example/${key}?expires=${seconds}`; }
}

describe('TOS credentials', () => {
  let directory: string;
  beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'tos-env-'))); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const write = async (text: string, mode = 0o600) => { const file = join(directory, 'tos.env'); await writeFile(file, text); await chmod(file, mode); return file; };

  it('reads the two key lines from a private file', async () => {
    const file = await write(`# muse tos\nexport VOLCENGINE_ACCESS_KEY_ID=AKLTexample123\nVOLCENGINE_SECRET_ACCESS_KEY="${secret}"\n`, 0o640);
    expect(await readTosCredentials(file)).toEqual({ accessKeyId: 'AKLTexample123', secretAccessKey: secret });
  });

  it('refuses public, incomplete or relative files without echoing their contents', async () => {
    for (const [text, mode] of [[`VOLCENGINE_ACCESS_KEY_ID=AKLTexample123\nVOLCENGINE_SECRET_ACCESS_KEY=${secret}\n`, 0o644], [`VOLCENGINE_SECRET_ACCESS_KEY=${secret}\n`, 0o600]] as const) {
      const error = await readTosCredentials(await write(text, mode)).then(() => null, (reason: Error) => reason);
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).not.toContain(secret);
    }
    await expect(readTosCredentials('tos.env')).rejects.toThrow(/absolute/);
  });
});

describe('TOS SDK binding', () => {
  it('signs a private GET link offline and builds public addresses from the key', async () => {
    const settings = { bucket: 'muse', region: 'cn-beijing', endpoint: 'tos-cn-beijing.volces.com' };
    const key = 'download-video-date/douyin/20261115/7529749968874113060/video/001-7570000000000000001.mp4';
    const store = await createTosObjectStore({ ...settings, access: 'private' }, { accessKeyId: 'AKLTexample123', secretAccessKey: secret });
    const signed = new URL(store.link(key, 3600));
    expect(signed.host).toBe('muse.tos-cn-beijing.volces.com');
    expect(signed.pathname).toBe(`/${key}`);
    expect(signed.searchParams.get('X-Tos-Expires')).toBe('3600');
    expect(signed.searchParams.get('X-Tos-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.href).not.toContain(secret);
    const open = await createTosObjectStore({ ...settings, access: 'public' }, { accessKeyId: 'AKLTexample123', secretAccessKey: secret });
    expect(open.link(key, 3600)).toBe(publicObjectUrl(settings, key));
    expect(publicObjectUrl(settings, 'download-video-date/douyin/20261115/1/video/a b.mp4')).toBe('https://muse.tos-cn-beijing.volces.com/download-video-date/douyin/20261115/1/video/a%20b.mp4');
  });
});

describe('video download', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'douyin-dl-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const bytes = new Uint8Array(70_000).map((_, index) => index % 251);

  it('sends Referer and UA, falls back to the next address and hashes what it wrote', async () => {
    const seen: { url: string; referer: string | null }[] = [];
    const result = await downloadVideo(['https://a.example/1.mp4', 'https://b.example/1.mp4'], join(directory, 'v.part'), { maxBytes: 1_000_000, timeoutMs: 5_000, signal: AbortSignal.timeout(5_000),
      fetch: async (url, init) => {
        seen.push({ url: String(url), referer: new Headers(init?.headers).get('referer') });
        return String(url).startsWith('https://a.') ? new Response('denied', { status: 403 }) : new Response(bytes, { headers: { 'content-type': 'video/mp4' } });
      } });
    expect(result).toEqual({ bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(seen.map(item => item.referer)).toEqual(['https://www.douyin.com/', 'https://www.douyin.com/']);
    expect(await readFile(join(directory, 'v.part'))).toEqual(Buffer.from(bytes));
  });

  it('stops at the size limit and leaves no partial file', async () => {
    await expect(downloadVideo(['https://a.example/1.mp4'], join(directory, 'big.part'), { maxBytes: 1_000, timeoutMs: 5_000, signal: AbortSignal.timeout(5_000),
      fetch: async () => new Response(bytes, { headers: { 'content-type': 'video/mp4' } }) })).rejects.toThrow('大小上限');
    expect(await readdir(directory)).toEqual([]);
    await expect(downloadVideo(['https://a.example/1.mp4'], join(directory, 'page.part'), { maxBytes: 1_000_000, timeoutMs: 5_000, signal: AbortSignal.timeout(5_000),
      fetch: async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) })).rejects.toThrow('HTTP 200');
  });
});

describe('download queue', () => {
  let database: PGlite, store: FakeStore, manager: DouyinDownloadManager, now: number, reads: string[], work: string;
  let pages: Record<string, { items: unknown[]; has_more: boolean; cursor?: string }>;
  const video = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const create = (options: Partial<ConstructorParameters<typeof DouyinDownloadManager>[3]> = {}) => new DouyinDownloadManager(database, {
    read: async (path, query) => {
      reads.push(`${path}:${query.aweme_id ?? query.cursor ?? ''}`);
      if (path === 'video') { const id = query.aweme_id!; return post(id, Number(id.slice(-1)) || null, id.startsWith('8') ? null : '7529749968874113060'); }
      return pages[query.cursor ?? ''];
    } }, store, { access: 'private', linkSeconds: 3600, dailyLimit: 3, maxMixEpisodes: 4, maxVideoBytes: 1_000_000, intervalMs: 0, maxAttempts: 2,
    workDirectory: work, now: () => now, fetch: async () => new Response(video, { headers: { 'content-type': 'video/mp4' } }), ...options });
  beforeEach(async () => {
    database = new PGlite();
    work = resolve(process.cwd(), '.data', `douyin-download-tests-${randomUUID()}`);
    store = new FakeStore(); now = T0; reads = [];
    pages = {
      '': { items: [post('7570000000000000003', 3), post('7570000000000000001', 1)], has_more: true, cursor: 'p2' },
      p2: { items: [post('7570000000000000002', 2)], has_more: false },
    };
    manager = create();
    await manager.initialize();
  });
  afterEach(async () => { await database.close(); await rm(work, { recursive: true, force: true }); });

  it('runs several downloads at once and gives the next one to the member with the fewest running', async () => {
    expect(() => create({ concurrency: 0 })).toThrow('Invalid Douyin download limits');
    expect(() => create({ concurrency: 17 })).toThrow('Invalid Douyin download limits');
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const started: string[] = [];
    const parallel = create({ concurrency: 2, fetch: async url => {
      started.push(/\/(\d+)\.mp4/.exec(String(url))![1]!);
      await gate;
      return new Response(video, { headers: { 'content-type': 'video/mp4' } });
    } });
    expect((await parallel.requestMix(member, '7529749968874113060')).queued).toHaveLength(3);
    now = T0 + 1_000;
    expect((await parallel.requestPost(admin, '8570000000000000009')).queued).toHaveLength(1);
    parallel.start();
    await vi.waitFor(() => expect(started).toEqual(['7570000000000000001', '8570000000000000009']));
    const running = (await parallel.list(admin, { mine: false, limit: 10 })).filter(item => item.state !== 'queued');
    expect(running.map(item => item.awemeId).sort()).toEqual(['7570000000000000001', '8570000000000000009']);
    release();
    await vi.waitFor(async () => expect((await parallel.list(admin, { mine: false, limit: 10 })).every(item => item.state === 'done')).toBe(true));
    expect(started.slice(2)).toEqual(['7570000000000000002', '7570000000000000003']);
    await parallel.stop();
  });

  it('wakes idle workers on a new request and stops while they wait', async () => {
    const parallel = create({ concurrency: 3 });
    parallel.start();
    parallel.start();
    await new Promise(done => setTimeout(done, 20));
    await parallel.requestPost(member, '7570000000000000002');
    await vi.waitFor(async () => expect((await parallel.list(member, { mine: true, limit: 10 }))[0]?.state).toBe('done'));
    await parallel.stop();
    parallel.start();
    expect(store.uploads).toHaveLength(1);
  });

  it('queues a post under its series folder, then downloads, uploads and verifies it once', async () => {
    const result = await manager.requestPost(member, '7570000000000000002');
    expect(result.queued[0]).toMatchObject({ state: 'queued', mixId: '7529749968874113060', episode: 2, requestedBy: '成员甲',
      key: 'download-video-date/douyin/20261115/7529749968874113060/video/002-7570000000000000002.mp4' });
    expect((await manager.requestPost(member, '7570000000000000002')).existing).toHaveLength(1);
    expect(await manager.processNext()).toBe(true);
    const [saved] = await manager.list(member, { mine: true, limit: 10 });
    expect(saved).toMatchObject({ state: 'done', bytes: 8, sha256: createHash('sha256').update(video).digest('hex'), attempts: 1 });
    expect(store.uploads).toEqual([saved!.key]);
    expect(await readdir(work)).toEqual([]);
    expect(await manager.processNext()).toBe(false);
    expect((await manager.link(saved!.id)).url).toBe(`https://signed.example/${saved!.key}?expires=3600`);
    expect(saved!.url).toBeNull();
    const publicManager = create({ access: 'public' });
    expect((await publicManager.list(member, { mine: true, limit: 10 }))[0]?.url).toBe(`https://signed.example/${saved!.key}?expires=3600`);
    const single = await manager.requestPost(member, '8570000000000000001');
    expect(single.queued[0]?.key).toBe('download-video-date/douyin/20261115/8570000000000000001/video/001-8570000000000000001.mp4');
    expect((await manager.list(member, { mine: false, awemeIds: ['7570000000000000002', '9999'], limit: 10 })).map(item => item.awemeId)).toEqual(['7570000000000000002']);
  });

  it('reuses an identical existing object and stops on conflicting or corrupt saved bytes', async () => {
    const { queued: [first] } = await manager.requestPost(member, '7570000000000000001');
    store.objects.set(first!.key, { bytes: 8, sha256: createHash('sha256').update(video).digest('hex') });
    await manager.processNext();
    expect((await manager.list(member, { mine: true, limit: 10 }))[0]?.state).toBe('done');
    expect(store.uploads).toEqual([]);
    const { queued: [second] } = await manager.requestPost(member, '7570000000000000003');
    store.objects.set(second!.key, { bytes: 99, sha256: null });
    await manager.processNext();
    expect(await manager.get(second!.id)).toMatchObject({ state: 'failed', attempts: 1, nextRetryAt: null, errorCode: 'OBJECT_CONFLICT', error: 'TOS 已有同名但内容不同的文件，没有覆盖' });
    expect(await manager.processNext()).toBe(false);
    await expect(manager.link(second!.id)).rejects.toMatchObject({ status: 409 });
    store.objects.delete(second!.key); store.corrupt = true;
    expect((await manager.requestPost(member, '7570000000000000003')).queued).toHaveLength(1);
    await manager.processNext();
    expect((await manager.get(second!.id))?.error).toContain('SHA-256');
  });

  it('retries in bounded groups, persists and caps cooldowns, and keeps the original identity and quota', async () => {
    let available = false;
    const retrying = create({ retryDelayMs: 100, cooldownMs: 1_000, maxCooldownMs: 2_000,
      fetch: async () => available ? new Response(video, { headers: { 'content-type': 'video/mp4' } }) : new Response('busy', { status: 503 }) });
    const initial = (await retrying.requestPost(member, '7570000000000000001')).queued[0]!;
    for (let round = 1; round <= 3; round++) {
      await retrying.processNext();
      let current = (await retrying.get(initial.id))!;
      expect(current).toMatchObject({ state: 'queued', attempts: (round - 1) * 2 + 1, nextRetryAt: new Date(now + 100).toISOString() });
      expect(await retrying.processNext()).toBe(false);
      now += 100;
      await retrying.processNext();
      current = (await retrying.get(initial.id))!;
      expect(current).toMatchObject({ id: initial.id, key: initial.key, state: 'queued', cooldownRounds: round,
        nextRetryAt: new Date(now + (round === 1 ? 1_000 : 2_000)).toISOString(), errorCode: 'VIDEO_TRANSFER_FAILED' });
      expect((await retrying.requestPost(member, initial.awemeId)).existing[0]!.id).toBe(initial.id);
      expect(await retrying.processNext()).toBe(false);
      expect((await retrying.status(member)).usedToday).toBe(1);
      now = Date.parse(current.nextRetryAt!);
    }
    available = true;
    await retrying.processNext();
    expect(await retrying.get(initial.id)).toMatchObject({ id: initial.id, key: initial.key, state: 'done', attempts: 7, nextRetryAt: null, error: null, errorCode: null });
    expect(await retrying.list(member, { mine: true, limit: 10 })).toHaveLength(1);
    expect(store.uploads).toEqual([initial.key]);
    expect(await readdir(work)).toEqual([]);
  });

  it('retains retry times across worker initialization and lets another member download during cooldown', async () => {
    const retrying = create({ maxAttempts: 1, cooldownMs: 1_000, maxCooldownMs: 1_000,
      fetch: async () => new Response('busy', { status: 503 }) });
    const initial = (await retrying.requestPost(member, '7570000000000000001')).queued[0]!;
    await retrying.processNext();
    const scheduled = await retrying.get(initial.id);
    const restarted = create();
    await restarted.initialize();
    expect(await restarted.get(initial.id)).toEqual(scheduled);
    expect(await restarted.processNext()).toBe(false);
    const other = (await restarted.requestPost(admin, '8570000000000000002')).queued[0]!;
    await restarted.processNext();
    expect(await restarted.get(other.id)).toMatchObject({ state: 'done' });
    expect(await restarted.get(initial.id)).toEqual(scheduled);
    now = Date.parse(scheduled!.nextRetryAt!);
    await restarted.processNext();
    expect(await restarted.get(initial.id)).toMatchObject({ state: 'done', attempts: 2 });
  });

  it('waits until a retry is due and wakes automatically without another click', async () => {
    let failures = true;
    const retrying = create({ now: Date.now, maxAttempts: 1, cooldownMs: 1_000, maxCooldownMs: 1_000,
      fetch: async () => failures ? new Response('busy', { status: 503 }) : new Response(video, { headers: { 'content-type': 'video/mp4' } }) });
    const initial = (await retrying.requestPost(member, '7570000000000000001')).queued[0]!;
    await retrying.processNext();
    failures = false;
    retrying.start();
    try {
      await vi.waitFor(async () => expect((await retrying.get(initial.id))?.state).toBe('done'), { timeout: 8_000, interval: 50 });
      expect((await retrying.get(initial.id))?.attempts).toBe(2);
    } finally { await retrying.stop(); }
  });

  it('keeps a cooling request through closing and reopening its durable database', async () => {
    const path = join(work, 'durable-database');
    const options = { access: 'private' as const, linkSeconds: 3600, dailyLimit: 3, maxMixEpisodes: 4,
      maxVideoBytes: 1_000_000, intervalMs: 0, maxAttempts: 1, cooldownMs: 1_000, maxCooldownMs: 1_000, workDirectory: work, now: () => now };
    const reader = { read: async () => post('7570000000000000001', 1) };
    const firstDatabase = new PGlite(path);
    let initial!: DouyinDownloadRequestResult['queued'][number];
    let scheduled!: string;
    try {
      const first = new DouyinDownloadManager(firstDatabase, reader, store, { ...options, fetch: async () => new Response('busy', { status: 503 }) });
      await first.initialize();
      initial = (await first.requestPost(member, '7570000000000000001')).queued[0]!;
      await first.processNext();
      scheduled = (await first.get(initial.id))!.nextRetryAt!;
    } finally { await firstDatabase.close(); }
    const secondDatabase = new PGlite(path);
    try {
      const second = new DouyinDownloadManager(secondDatabase, reader, store, { ...options, fetch: async () => new Response(video, { headers: { 'content-type': 'video/mp4' } }) });
      await second.initialize();
      expect(await second.get(initial.id)).toMatchObject({ nextRetryAt: scheduled, cooldownRounds: 1, attempts: 1 });
      expect(await second.processNext()).toBe(false);
      now = Date.parse(scheduled);
      await second.processNext();
      expect(await second.get(initial.id)).toMatchObject({ state: 'done', key: initial.key, attempts: 2, nextRetryAt: null });
    } finally { await secondDatabase.close(); }
  });

  it('reconciles a lost upload reply without downloading or uploading the post again', async () => {
    const upload = store.upload.bind(store);
    store.upload = async (...args) => { await upload(...args); throw new DouyinDownloadError('连接中断', 502, true, 'TOS_UPLOAD_FAILED'); };
    const retrying = create({ retryDelayMs: 100 });
    const initial = (await retrying.requestPost(member, '7570000000000000001')).queued[0]!;
    await retrying.processNext();
    expect(await retrying.get(initial.id)).toMatchObject({ state: 'queued', errorCode: 'TOS_UPLOAD_FAILED' });
    const count = reads.length;
    now += 100;
    await retrying.processNext();
    expect(await retrying.get(initial.id)).toMatchObject({ state: 'done', attempts: 2, nextRetryAt: null });
    expect(reads).toHaveLength(count);
    expect(store.uploads).toEqual([initial.key]);
  });

  it('stops retries for a login or verification refusal and hides unexpected storage diagnostics', async () => {
    for (const code of ['IDENTITY_LOGIN_REQUIRED', 'UPSTREAM_RISK_CONTROL']) {
      const initial = (await manager.requestPost(member, code === 'IDENTITY_LOGIN_REQUIRED' ? '7570000000000000001' : '7570000000000000002')).queued[0]!;
      const refused = new DouyinDownloadManager(database, { read: async () => { throw new DouyinSearchError('需要管理员处理', 503, code); } }, store,
        { access: 'private', linkSeconds: 3600, dailyLimit: 3, maxMixEpisodes: 4, maxVideoBytes: 1_000_000, intervalMs: 0, maxAttempts: 2, workDirectory: work, now: () => now });
      await refused.processNext();
      expect(await refused.get(initial.id)).toMatchObject({ state: 'failed', errorCode: code, nextRetryAt: null, attempts: 1 });
    }
    const initial = (await manager.requestPost(member, '7570000000000000003')).queued[0]!;
    store.head = async () => { throw new Error(`private path /srv/private/secret and ${secret}`); };
    await manager.processNext();
    const result = await manager.get(initial.id);
    expect(result).toMatchObject({ state: 'failed', errorCode: 'DOWNLOAD_INTERNAL', nextRetryAt: null });
    expect(result!.error).not.toContain(secret);
    expect(result!.error).not.toContain('/srv/private');
    const unknown = (await manager.requestPost(admin, '8570000000000000002')).queued[0]!;
    const foreign = new DouyinDownloadManager(database, { read: async () => { throw new DouyinSearchError('暂时不可用', 502, secret); } }, store,
      { access: 'private', linkSeconds: 3600, dailyLimit: 3, maxMixEpisodes: 4, maxVideoBytes: 1_000_000, intervalMs: 0, maxAttempts: 2, workDirectory: work, now: () => now });
    await foreign.processNext();
    expect(await foreign.get(unknown.id)).toMatchObject({ state: 'queued', errorCode: 'SOURCE_UNAVAILABLE' });
    expect(JSON.stringify(await foreign.get(unknown.id))).not.toContain(secret);
  });

  it('lists a whole series across pages and queues it in episode order within the daily limit', async () => {
    await manager.requestPost(member, '7570000000000000002');
    const result: DouyinDownloadRequestResult = await manager.requestMix(member, '7529749968874113060');
    expect(result.existing.map(item => item.episode)).toEqual([2]);
    expect(result.queued.map(item => item.episode)).toEqual([1, 3]);
    expect(result.skipped).toBe(0);
    expect((await manager.status(member)).usedToday).toBe(3);
    await expect(manager.requestPost(member, '8570000000000000001')).rejects.toMatchObject({ status: 429 });
    expect((await manager.requestPost(admin, '8570000000000000001')).queued).toHaveLength(1);
    now += 24 * 3_600_000;
    expect((await manager.status(member)).usedToday).toBe(0);
    const order: number[] = [];
    while (await manager.processNext()) order.push(1);
    expect((await manager.list(member, { mine: false, limit: 10 })).filter(item => item.state === 'done')).toHaveLength(4);
  });

  it('skips series episodes beyond the remaining quota and refuses series above the episode cap', async () => {
    const small = create({ dailyLimit: 2 });
    const result = await small.requestMix(member, '7529749968874113060');
    expect(result.queued.map(item => item.episode)).toEqual([1, 2]);
    expect(result.skipped).toBe(1);
    pages[''] = { items: [1, 2, 3, 4, 5].map(n => post(`757000000000000010${n}`, n)), has_more: false };
    await expect(create().requestMix(admin, '7529749968874113060')).rejects.toMatchObject({ status: 400 });
  });

  it('serves status, requests, the log and the file redirect only to signed-in members', async () => {
    const repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    const users: Record<string, UserIdentity> = { member };
    const { app } = createApp({ repository, douyinDownloads: manager, identity: async request => users[request.headers.get('test-user') ?? ''] ?? null });
    const origin = 'http://127.0.0.1:4317';
    const headers = { 'test-user': 'member', origin, 'content-type': 'application/json' };
    expect((await app.request(`${origin}/api/douyin/downloads`)).status).toBe(401);
    expect((await (await app.request(`${origin}/api/douyin/downloads/status`, { headers })).json() as DouyinDownloadStatus)).toMatchObject({ enabled: true, access: 'private', dailyLimit: 3, usedToday: 0 });
    expect((await app.request(`${origin}/api/douyin/downloads`, { method: 'POST', headers: { 'test-user': 'member', 'content-type': 'application/json' }, body: '{"awemeId":"7570000000000000001"}' })).status).toBe(403);
    const requested = await app.request(`${origin}/api/douyin/downloads`, { method: 'POST', headers, body: '{"awemeId":"7570000000000000001"}' });
    expect(requested.status).toBe(202);
    const id = (await requested.json() as DouyinDownloadRequestResult).queued[0]!.id;
    expect((await app.request(`${origin}/api/douyin/downloads/${id}/file`, { headers })).status).toBe(409);
    await manager.processNext();
    const file = await app.request(`${origin}/api/douyin/downloads/${id}/file`, { headers });
    expect(file.status).toBe(302);
    expect(file.headers.get('location')).toContain('https://signed.example/download-video-date/douyin/20261115/');
    expect((await (await app.request(`${origin}/api/douyin/downloads?mine=1`, { headers })).json() as unknown[]).length).toBe(1);
    const { app: off } = createApp({ repository, identity: async () => member });
    expect(await (await off.request(`${origin}/api/douyin/downloads/status`)).json()).toMatchObject({ enabled: false, reason: 'TOS 未配置' });
    const refused = await off.request(`${origin}/api/douyin/downloads`);
    expect(refused.status).toBe(503);
    expect((await refused.json()).error).toContain('TOS 未配置');
  });
});

describe('Muse download API', () => {
  let database: PGlite, store: FakeStore, manager: DouyinDownloadManager, work: string;
  const token = 'm'.repeat(40);
  beforeEach(async () => {
    database = new PGlite();
    work = resolve(process.cwd(), '.data', `douyin-service-tests-${randomUUID()}`);
    store = new FakeStore();
    manager = new DouyinDownloadManager(database, { read: async (_path, query) => post(query.aweme_id!, 2) }, store, { access: 'public', linkSeconds: 3600, dailyLimit: 1,
      maxMixEpisodes: 300, maxVideoBytes: 1_000_000, intervalMs: 0, maxAttempts: 2, workDirectory: work, now: () => T0,
      fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } }) });
    await manager.initialize();
  });
  afterEach(async () => { await database.close(); await rm(work, { recursive: true, force: true }); });

  it('lets the Muse tool request, follow and fetch downloads with the service token only', async () => {
    const repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    const { app } = createApp({ repository, douyinDownloads: manager, service: createServiceIdentity(token), identity: async () => member });
    const origin = 'http://127.0.0.1:4317';
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    expect((await app.request(`${origin}/api/service/douyin/downloads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"awemeId":"7570000000000000002"}' })).status).toBe(401);
    expect((await app.request(`${origin}/api/service/douyin/downloads`, { method: 'POST', headers: { ...headers, origin }, body: '{"awemeId":"7570000000000000002"}' })).status).toBe(403);
    const requested = await app.request(`${origin}/api/service/douyin/downloads`, { method: 'POST', headers, body: JSON.stringify({ awemeId: '7570000000000000002', requestedBy: '用户乙' }) });
    expect(requested.status).toBe(202);
    const queued = (await requested.json() as DouyinDownloadRequestResult).queued[0]!;
    expect(queued).toMatchObject({ requestedBy: '用户乙（Muse）', state: 'queued' });
    expect((await app.request(`${origin}/api/service/douyin/downloads`, { method: 'POST', headers, body: JSON.stringify({ awemeId: '7570000000000000003', requestedBy: '用户乙' }) })).status).toBe(429);
    expect(await (await app.request(`${origin}/api/service/douyin/downloads/status?requestedBy=${encodeURIComponent('用户乙')}`, { headers })).json()).toMatchObject({ enabled: true, usedToday: 1, dailyLimit: 1 });
    expect((await app.request(`${origin}/api/service/douyin/downloads`, { headers })).status).toBe(400);
    expect(await (await app.request(`${origin}/api/service/douyin/downloads/${queued.id}`, { headers })).json()).toMatchObject({ download: { state: 'queued' }, file: null });
    await manager.processNext();
    const listed = await (await app.request(`${origin}/api/service/douyin/downloads?awemeIds=7570000000000000002`, { headers })).json() as { state: string; url: string }[];
    expect(listed[0]).toMatchObject({ state: 'done', url: `https://signed.example/${queued.key}?expires=3600` });
    expect(await (await app.request(`${origin}/api/service/douyin/downloads/${queued.id}`, { headers })).json()).toMatchObject({ download: { state: 'done' }, file: { url: `https://signed.example/${queued.key}?expires=3600`, expiresAt: null } });
    // Member routes still need a signed-in member; the token does not stand in for one.
    const { app: guarded } = createApp({ repository, douyinDownloads: manager, service: createServiceIdentity(token), identity: async () => null });
    expect((await guarded.request(`${origin}/api/douyin/downloads?mine=1`, { headers })).status).toBe(401);
  });
});

describe('desktop Muse download API (member account token)', () => {
  let database: PGlite, store: FakeStore, manager: DouyinDownloadManager, work: string, directory: string;
  const accounts: Record<string, MuseAccount> = { ['a'.repeat(32)]: { version: 1, accountId: 'acc-1', username: 'userb', admin: true }, ['b'.repeat(32)]: { version: 1, accountId: 'acc-2', username: 'outsider', admin: false } };
  let lookups: string[];
  beforeEach(async () => {
    database = new PGlite();
    work = resolve(process.cwd(), '.data', `douyin-client-tests-${randomUUID()}`);
    directory = await realpath(await mkdtemp(join(tmpdir(), 'client-identity-')));
    store = new FakeStore(); lookups = [];
    manager = new DouyinDownloadManager(database, { read: async (_path, query) => post(query.aweme_id!, 2) }, store, { access: 'public', linkSeconds: 3600, dailyLimit: 1,
      maxMixEpisodes: 300, maxVideoBytes: 1_000_000, intervalMs: 0, maxAttempts: 2, workDirectory: work, now: () => T0,
      fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } }) });
    await manager.initialize();
  });
  afterEach(async () => { await database.close(); await rm(work, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); });

  it('admits listed Muse accounts by their own token, records them by account, and caches the gateway answer', async () => {
    const file = join(directory, 'identities.json');
    await writeFile(file, JSON.stringify({ version: 1, proxySecret: 'f'.repeat(64), users: [{ username: 'userb', id: 'muse-acc-1', name: '用户乙', role: 'member' }] }));
    await chmod(file, 0o600);
    let now = T0;
    const accountIdentity = await createMuseAccountTokenIdentity(file, { cacheMs: 60_000, now: () => now,
      lookup: async token => { lookups.push(token.slice(0, 1)); if (token === 'c'.repeat(32)) throw new Error('gateway down'); return accounts[token] ?? null; } });
    const repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    const { app } = createApp({ repository, douyinDownloads: manager, accountIdentity, service: createServiceIdentity('m'.repeat(40)), identity: async () => null });
    const origin = 'http://127.0.0.1:4317';
    const call = (path: string, token: string | null, init: RequestInit = {}) => app.request(`${origin}${path}`, { ...init,
      headers: { ...(token ? { 'X-Muse-Account-Token': token } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers as Record<string, string> } });
    expect((await call('/api/muse-client/douyin/downloads/status', null)).status).toBe(401);
    expect((await call('/api/muse-client/douyin/downloads/status', 'z'.repeat(32))).status).toBe(401);
    expect((await call('/api/muse-client/douyin/downloads/status', 'b'.repeat(32))).status).toBe(403);
    expect((await call('/api/muse-client/douyin/downloads/status', 'c'.repeat(32))).status).toBe(503);
    expect((await call('/api/muse-client/douyin/downloads/status', 'a'.repeat(32), { headers: { origin } })).status).toBe(403);
    // The shared service token is not an account token.
    expect((await app.request(`${origin}/api/muse-client/douyin/downloads/status`, { headers: { authorization: `Bearer ${'m'.repeat(40)}` } })).status).toBe(401);
    const token = 'a'.repeat(32);
    expect(await (await call('/api/muse-client/douyin/downloads/status', token)).json()).toMatchObject({ enabled: true, usedToday: 0, dailyLimit: 1 });
    const requested = await call('/api/muse-client/douyin/downloads', token, { method: 'POST', body: JSON.stringify({ awemeId: '7570000000000000002' }) });
    expect(requested.status).toBe(202);
    const queued = (await requested.json() as DouyinDownloadRequestResult).queued[0]!;
    expect(queued.requestedBy).toBe('用户乙');
    expect((await call('/api/muse-client/douyin/downloads', token, { method: 'POST', body: JSON.stringify({ awemeId: '7570000000000000002', requestedBy: '别人' }) })).status).toBe(400);
    expect((await call('/api/muse-client/douyin/downloads', token, { method: 'POST', body: JSON.stringify({ awemeId: '7570000000000000003' }) })).status).toBe(429);
    await manager.processNext();
    const listed = await (await call('/api/muse-client/douyin/downloads?awemeIds=7570000000000000002', token)).json() as { state: string; url: string }[];
    expect(listed[0]).toMatchObject({ state: 'done', url: `https://signed.example/${queued.key}?expires=3600` });
    expect(await (await call(`/api/muse-client/douyin/downloads/${queued.id}`, token)).json()).toMatchObject({ download: { state: 'done' }, file: { url: `https://signed.example/${queued.key}?expires=3600` } });
    expect(lookups.filter(item => item === 'a')).toHaveLength(1);
    now += 61_000;
    await call('/api/muse-client/douyin/downloads/status', token);
    expect(lookups.filter(item => item === 'a')).toHaveLength(2);
    const { app: off } = createApp({ repository, douyinDownloads: manager, identity: async () => null });
    expect((await off.request(`${origin}/api/muse-client/douyin/downloads/status`, { headers: { 'X-Muse-Account-Token': token } })).status).toBe(404);
  });
});

describe('download configuration', () => {
  it('defaults to public objects with bounded retry groups and configurable cooldowns', () => {
    expect(resolveConfig({}).douyinDownload).toEqual({ bucket: 'muse', region: 'cn-beijing', endpoint: 'tos-cn-beijing.volces.com', access: 'public',
      linkSeconds: 3600, dailyLimit: 50, maxMixEpisodes: 300, maxVideoBytes: 1_073_741_824, intervalMs: 3000, concurrency: 3,
      maxAttempts: 3, retryDelayMs: 5_000, cooldownMs: 300_000, maxCooldownMs: 3_600_000 });
    expect(resolveConfig({ MUSE_DATA_DOUYIN_DOWNLOAD_CONCURRENCY: '5' }).douyinDownload.concurrency).toBe(5);
    expect(() => resolveConfig({ MUSE_DATA_DOUYIN_DOWNLOAD_CONCURRENCY: '0' })).toThrow();
    expect(resolveConfig({ MUSE_DATA_DOUYIN_DOWNLOAD_MAX_ATTEMPTS: '4', MUSE_DATA_DOUYIN_DOWNLOAD_RETRY_DELAY_MS: '1000',
      MUSE_DATA_DOUYIN_DOWNLOAD_COOLDOWN_MINUTES: '10', MUSE_DATA_DOUYIN_DOWNLOAD_MAX_COOLDOWN_MINUTES: '30' }).douyinDownload).toMatchObject({ maxAttempts: 4, retryDelayMs: 1_000, cooldownMs: 600_000, maxCooldownMs: 1_800_000 });
    expect(() => resolveConfig({ MUSE_DATA_DOUYIN_DOWNLOAD_MAX_ATTEMPTS: '0' })).toThrow();
    expect(() => resolveConfig({ MUSE_DATA_DOUYIN_DOWNLOAD_COOLDOWN_MINUTES: '10', MUSE_DATA_DOUYIN_DOWNLOAD_MAX_COOLDOWN_MINUTES: '5' })).toThrow(/MAX_COOLDOWN/);
    expect(resolveConfig({ MUSE_DATA_DOUYIN_OBJECT_ACCESS: 'private', MUSE_DATA_TOS_ENV_FILE: '/srv/muse-data-web/access/tos.env' })).toMatchObject({ douyinDownload: { access: 'private' }, tosEnvFile: '/srv/muse-data-web/access/tos.env' });
    expect(() => resolveConfig({ MUSE_DATA_TOS_ENV_FILE: 'tos.env' })).toThrow(/absolute/);
    expect(() => resolveConfig({ MUSE_DATA_TOS_ENDPOINT: 'evil.example.com' })).toThrow();
  });
});

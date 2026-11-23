import { PGlite } from '@electric-sql/pglite';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NovelLibrary } from '../src/server/novels/library.ts';
import { NovelDownloadManager } from '../src/server/novels/manager.ts';
import { registerNovelRoutes } from '../src/server/novels/routes.ts';
import { NovelSourceError, type NovelDirectory, type NovelSourceAdapter } from '../src/server/novels/source.ts';
import { DataRepository } from '../src/server/repository.ts';
import type { Work } from '../src/shared/types.ts';

const time = '2026-11-13T12:00:00.000Z';
const body = '这是经过来源核验的章节正文。人物走过长街，故事仍在继续。';
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});
function work(sourceId = '7000000000000000001', platform: 'fanqie' | 'qimao' = 'fanqie'): Work {
  return { id: `${platform}:${sourceId}`, sourceId, platform, kind: 'novel', title: '原小说测试', author: '作者',
    description: '简介不能当作原文', coverUrl: null, sourceUrl: platform === 'fanqie' ? `https://fanqienovel.com/page/${sourceId}` : `https://www.qimao.com/shuku/${sourceId}/`,
    tags: [], category: '', episodeCount: null, wordCount: null, serialStatus: null, publishedAt: null, metrics: [],
    rank: null, rankChange: null, board: '', origin: 'live', observedAt: time, sourceUpdatedAt: null };
}
function directory(item = work(), count = 2, finished = false): NovelDirectory {
  return { workId: item.id, sourceId: item.sourceId, platform: item.platform as 'fanqie' | 'qimao', title: item.title!, author: item.author,
    sourceUrl: item.sourceUrl, observedAt: time, declaredChapterCount: count, finished,
    chapters: Array.from({ length: count }, (_, index) => ({ id: String(1001 + index), index: index + 1, title: `第${index + 1}章 来源章节标题`,
      sourceUrl: item.platform === 'fanqie' ? `https://fanqienovel.com/reader/${1001 + index}` : `https://www.qimao.com/shuku/${item.sourceId}-${1001 + index}/`,
      wordCount: 10, sourceUpdatedAt: '来源章节第一版' })) };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

async function fixture(options: { adapters?: Partial<Record<'fanqie' | 'qimao', NovelSourceAdapter>>; library?: ConstructorParameters<typeof NovelLibrary>[2];
  manager?: ConstructorParameters<typeof NovelDownloadManager>[3]; works?: Work[] } = {}) {
  await mkdir(resolve('.data'), { recursive: true });
  const root = await mkdtemp(resolve('.data', 'novels-core-'));
  const database = new PGlite(); const repository = new DataRepository(database); await repository.initialize({ seedDemo: false });
  const works = options.works ?? [work()];
  for (const item of works) await repository.ingestBatch({ platform: item.platform, works: [item], observedAt: item.observedAt, coverage: '隔离测试' });
  const library = new NovelLibrary(database, resolve(root, 'novel-files'), options.library);
  const source: NovelSourceAdapter = { platform: 'fanqie', directory: vi.fn(async item => directory(item)), chapter: vi.fn(async () => body), release: vi.fn(async () => {}) };
  const manager = new NovelDownloadManager(repository, library, options.adapters ?? { fanqie: source }, options.manager);
  await manager.initialize();
  return { root, database, repository, library, source, manager,
    close: async () => { await manager.stop(); await database.close(); await rm(root, { recursive: true, force: true }); } };
}

describe('private original-novel publication and independent durable jobs', () => {
  it('reuses one active job, publishes only the verified directory, and reuses old chapters when a serial gains a chapter', async () => {
    let count = 2;
    const f = await fixture();
    vi.mocked(f.source.directory).mockImplementation(async item => ({ ...directory(item, count, count === 3), observedAt: count === 2 ? time : '2026-11-14T12:00:00.000Z' }));
    try {
      const states = await Promise.all([f.manager.request(work()), f.manager.request(work())]);
      expect(states[0].job!.id).toBe(states[1].job!.id); expect(states[0].job!.state).toBe('queued');
      expect(await f.library.current(work().id)).toBeNull();
      f.manager.start(); await f.manager.waitForIdle();
      const first = await f.manager.status(work().id);
      expect(first.job).toMatchObject({ state: 'ready', completedChapters: 2, totalChapters: 2 });
      expect(first.artifact).toMatchObject({ scope: 'current-published-directory', chapterCount: 2, contentType: 'text/plain' });
      const original = (await f.library.read(first.artifact!.id))!;
      const text = new TextDecoder().decode(original.bytes);
      expect(text).toContain('非全本'); expect(text).toContain('第1章 来源章节标题'); expect(text).toContain(body);
      expect(first.artifact!.sha256).toBe(createHash('sha256').update(original.bytes).digest('hex'));
      expect(JSON.stringify(first)).not.toMatch(/novel-files|fileId|user_id|\.data/);
      count = 3;
      await f.manager.request(work()); await f.manager.waitForIdle();
      const newer = await f.manager.status(work().id);
      expect(newer.artifact).toMatchObject({ scope: 'complete-book', chapterCount: 3 });
      expect(newer.artifact!.id).not.toBe(first.artifact!.id);
      expect(f.source.chapter).toHaveBeenCalledTimes(3);
      expect(f.source.release).toHaveBeenCalledTimes(2);
      expect((await f.library.read(first.artifact!.id))!.bytes).toEqual(original.bytes);
    } finally { await f.close(); }
  });

  it('does not publish paid or partial chapters and keeps the previous ready version', async () => {
    const f = await fixture();
    try {
      f.manager.start(); await f.manager.request(work()); await f.manager.waitForIdle();
      const original = (await f.manager.status(work().id)).artifact!;
      vi.mocked(f.source.directory).mockImplementation(async item => directory(item, 3));
      vi.mocked(f.source.chapter).mockRejectedValue(new NovelSourceError('authorization_required', 'do not expose provider details'));
      await f.manager.request(work()); await f.manager.waitForIdle();
      const state = await f.manager.status(work().id);
      expect(state.job).toMatchObject({ state: 'failed', errorCode: 'authorization_required', completedChapters: 2, totalChapters: 3 });
      expect(state.artifact!.id).toBe(original.id);
      expect(JSON.stringify(state)).not.toContain('provider details');
      expect((await f.database.query<{ count: number }>('SELECT count(*)::int AS count FROM novel_artifacts')).rows[0]!.count).toBe(1);
      expect(f.source.release).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });

  it('aborts and joins release, restores an interrupted running job, and resumes only missing chapters after restart', async () => {
    const secondStarted = deferred(), releaseStarted = deferred(), finishRelease = deferred();
    const source: NovelSourceAdapter = { platform: 'fanqie', directory: async item => directory(item), chapter: vi.fn(async (_directory, chapter, signal) => {
      if (chapter.index === 1) return body;
      secondStarted.resolve();
      return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }), release: async () => { releaseStarted.resolve(); await finishRelease.promise; } };
    const f = await fixture({ adapters: { fanqie: source } });
    let reopened: NovelDownloadManager | undefined;
    try {
      f.manager.start(); await f.manager.request(work()); await secondStarted.promise;
      let stopped = false; const stopping = f.manager.stop().then(() => { stopped = true; });
      await releaseStarted.promise; expect(stopped).toBe(false);
      finishRelease.resolve(); await stopping;
      expect((await f.manager.status(work().id)).job).toMatchObject({ state: 'queued', completedChapters: 1, totalChapters: 2 });
      expect(await f.library.current(work().id)).toBeNull();
      await f.database.query("UPDATE novel_jobs SET payload=jsonb_set(payload,'{state}','\"running\"'::jsonb)");
      const chapter = vi.fn<NovelSourceAdapter['chapter']>(async () => body);
      reopened = new NovelDownloadManager(f.repository, f.library, { fanqie: { platform: 'fanqie', directory: async item => directory(item), chapter } });
      await reopened.initialize(); expect((await reopened.status(work().id)).job!.state).toBe('queued');
      reopened.start(); await reopened.waitForIdle();
      expect((await reopened.status(work().id)).job!.state).toBe('ready');
      expect(chapter).toHaveBeenCalledTimes(1);
      expect(chapter.mock.calls[0]![1]).toMatchObject({ id: '1002' });
    } finally { finishRelease.resolve(); await reopened?.stop(); await f.close(); }
  });

  it('rejects invalid directories, chapter URLs and incomplete numbering before any cache is published', async () => {
    const f = await fixture();
    try {
      const mutations: ((value: NovelDirectory) => void)[] = [
        value => { value.workId = 'fanqie:wrong'; }, value => { value.sourceId = '1'; }, value => { value.declaredChapterCount = 3; },
        value => { value.chapters[1]!.id = value.chapters[0]!.id; }, value => { value.chapters[1]!.index = 3; },
        value => { value.sourceUrl = 'https://evil.example/page/1'; }, value => { value.chapters[0]!.sourceUrl += '?account=secret'; },
        value => { value.chapters[0]!.sourceUrl = 'https://fanqienovel.com/reader/9999'; },
      ];
      for (const mutate of mutations) { const value = directory(); mutate(value); expect(() => f.library.validateDirectory(value, work())).toThrow(); }
      const extra = { ...directory(), credentials: 'not allowed' };
      expect(() => f.library.validateDirectory(extra, work())).toThrow();
      await expect(f.library.publish(directory())).rejects.toThrow('未完成章节');
      expect(await f.library.current(work().id)).toBeNull();
    } finally { await f.close(); }
  });

  it('refuses empty, private-use, replacement, invalid Unicode and short chapter text', async () => {
    const f = await fixture();
    try {
      const value = directory();
      for (const invalid of [' ', '\uE001'.repeat(100), '\u{F0001}'.repeat(100), '\uFFFD'.repeat(100), '\uD800'.repeat(100), '截文']) {
        await expect(f.library.saveChapter(value, value.chapters[0]!, invalid)).rejects.toMatchObject({ code: 'invalid_source' });
      }
      expect((await f.database.query('SELECT * FROM novel_chapters')).rows).toEqual([]);
      expect(await f.library.current(work().id)).toBeNull();
    } finally { await f.close(); }
  });

  it('uses a single global worker across platforms and bounds queued active work', async () => {
    const first = work(), second = work('1834789', 'qimao');
    const started = deferred(), release = deferred(); let active = 0, maximum = 0;
    const source = (platform: 'fanqie' | 'qimao'): NovelSourceAdapter => ({ platform, directory: async item => directory(item, 1),
      chapter: async () => { active++; maximum = Math.max(maximum, active); if (platform === 'fanqie') { started.resolve(); await release.promise; } active--; return body; } });
    const f = await fixture({ works: [first, second], adapters: { fanqie: source('fanqie'), qimao: source('qimao') }, manager: { maxQueued: 1 } });
    try {
      await f.manager.request(first);
      await expect(f.manager.request(second)).rejects.toMatchObject({ status: 429 });
      expect((await f.manager.request(first)).job!.state).toBe('queued');
      f.manager.start(); await started.promise;
      expect((await f.manager.status(second.id)).job).toBeNull();
      release.resolve(); await f.manager.waitForIdle();
      await f.manager.request(second); await f.manager.waitForIdle();
      expect(maximum).toBe(1); expect((await f.manager.status(second.id)).job!.state).toBe('ready');
    } finally { release.resolve(); await f.close(); }
  });

  it('enforces chapter, TXT and aggregate private-storage limits without publishing partial artifacts', async () => {
    for (const limits of [{ maxChapters: 1 }, { maxFileBytes: 100 }, { maxStorageBytes: 10 }]) {
      const f = await fixture({ library: limits });
      try {
        f.manager.start(); await f.manager.request(work()); await f.manager.waitForIdle();
        expect((await f.manager.status(work().id)).job).toMatchObject({ state: 'failed', errorCode: 'maxChapters' in limits ? 'invalid_source' : 'storage_limit' });
        expect(await f.library.current(work().id)).toBeNull();
      } finally { await f.close(); }
    }
  });

  it('returns quota after a partial file write or chapter database rollback so an exact-budget retry can succeed', async () => {
    const f = await fixture({ library: { maxStorageBytes: Buffer.byteLength(body) } });
    const value = directory(work(), 1), chapter = value.chapters[0]!;
    try {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args), write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => { await write('partial'); throw new Error('Injected partial write failure'); });
        return handle;
      });
      await expect(f.library.saveChapter(value, chapter, body)).rejects.toThrow('Injected partial write failure');
      expect(await readdir(resolve(f.root, 'novel-files'))).toEqual([]);
      await f.database.exec(`CREATE FUNCTION reject_chapter_cache() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected chapter database failure'; END $$;
        CREATE TRIGGER reject_chapter_cache BEFORE INSERT ON novel_chapters FOR EACH ROW EXECUTE FUNCTION reject_chapter_cache();`);
      await expect(f.library.saveChapter(value, chapter, body)).rejects.toThrow('injected chapter database failure');
      expect(await readdir(resolve(f.root, 'novel-files'))).toEqual([]);
      await f.database.exec('DROP TRIGGER reject_chapter_cache ON novel_chapters; DROP FUNCTION reject_chapter_cache();');
      await f.library.saveChapter(value, chapter, body);
      expect(await f.library.cachedChapter(value, chapter)).toBe(body);
      expect((await readdir(resolve(f.root, 'novel-files'))).length).toBe(1);
    } finally { await f.close(); }
  });

  it('returns TXT and manifest quota after rejected publication and rescans actual private bytes on reopening', async () => {
    const reference = await fixture({ library: { now: () => new Date(time) } });
    let budget: number;
    const value = directory(work(), 1);
    try {
      await reference.library.saveChapter(value, value.chapters[0]!, body); await reference.library.publish(value);
      budget = 0;
      for (const name of await readdir(resolve(reference.root, 'novel-files'))) budget += (await lstat(resolve(reference.root, 'novel-files', name))).size;
    } finally { await reference.close(); }
    const f = await fixture({ library: { maxStorageBytes: budget!, now: () => new Date(time) } });
    try {
      await f.library.saveChapter(value, value.chapters[0]!, body);
      await f.database.exec(`CREATE FUNCTION reject_novel_publication() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected publication database failure'; END $$;
        CREATE TRIGGER reject_novel_publication BEFORE INSERT ON novel_artifacts FOR EACH ROW EXECUTE FUNCTION reject_novel_publication();`);
      await expect(f.library.publish(value)).rejects.toThrow('injected publication database failure');
      expect((await readdir(resolve(f.root, 'novel-files'))).every(name => name.endsWith('.chapter'))).toBe(true);
      expect(await f.library.current(work().id)).toBeNull();
      await f.database.exec('DROP TRIGGER reject_novel_publication ON novel_artifacts; DROP FUNCTION reject_novel_publication();');
      const artifact = await f.library.publish(value);
      expect((await f.library.read(artifact.id))!.artifact.id).toBe(artifact.id);
      const reopened = new NovelLibrary(f.database, resolve(f.root, 'novel-files'), { maxStorageBytes: budget! });
      await reopened.initialize();
      const grown = directory(work(), 2);
      await expect(reopened.saveChapter(grown, grown.chapters[1]!, body)).rejects.toMatchObject({ status: 413 });
      expect((await reopened.read(artifact.id))!.artifact.id).toBe(artifact.id);
      await mkdir(resolve(f.root, 'novel-files', 'unknown-directory'));
      await expect(new NovelLibrary(f.database, resolve(f.root, 'novel-files')).initialize()).rejects.toThrow('不受支持');
    } finally { await f.close(); }
  });

  it('keeps a failed cleanup conservatively charged until a restart measures the actual partial file', async () => {
    const limit = Buffer.byteLength(body) * 2 - 1;
    const f = await fixture({ library: { maxStorageBytes: limit } });
    const value = directory(work(), 1), chapter = value.chapters[0]!;
    try {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args), write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => { await write('partial'); throw new Error('Injected partial write failure'); });
        return handle;
      });
      vi.mocked(unlink).mockRejectedValueOnce(new Error('Injected cleanup failure'));
      await expect(f.library.saveChapter(value, chapter, body)).rejects.toThrow('Injected cleanup failure');
      expect((await readdir(resolve(f.root, 'novel-files'))).length).toBe(1);
      await expect(f.library.saveChapter(value, chapter, body)).rejects.toMatchObject({ status: 413 });
      const reopened = new NovelLibrary(f.database, resolve(f.root, 'novel-files'), { maxStorageBytes: limit });
      await reopened.initialize(); await reopened.saveChapter(value, chapter, body);
      expect(await reopened.cachedChapter(value, chapter)).toBe(body);
      expect((await readdir(resolve(f.root, 'novel-files'))).length).toBe(2);
    } finally { await f.close(); }
  });

  it('checks chapter cache hashes and immutable TXT/manifest hashes while preserving old files', async () => {
    const f = await fixture();
    try {
      f.manager.start(); await f.manager.request(work()); await f.manager.waitForIdle();
      const artifact = (await f.manager.status(work().id)).artifact!;
      const cached = (await f.database.query<{ payload: { fileId: string } }>('SELECT payload FROM novel_chapters LIMIT 1')).rows[0]!.payload;
      const cachePath = resolve(f.root, 'novel-files', `${cached.fileId}.chapter`);
      const cacheBytes = await readFile(cachePath); await writeFile(cachePath, Buffer.alloc(cacheBytes.length, 65));
      await f.manager.request(work()); await f.manager.waitForIdle();
      expect((await f.manager.status(work().id)).job!.state).toBe('failed');
      expect((await f.library.read(artifact.id))!.artifact.id).toBe(artifact.id);
      const txt = resolve(f.root, 'novel-files', `${artifact.id}.txt`), original = await readFile(txt);
      await writeFile(txt, Buffer.alloc(original.length, 65)); await expect(f.library.read(artifact.id)).rejects.toMatchObject({ status: 409 });
      await writeFile(txt, original);
      const manifest = resolve(f.root, 'novel-files', `${artifact.id}.manifest.json`), originalManifest = await readFile(manifest);
      await writeFile(manifest, Buffer.alloc(originalManifest.length, 65)); await expect(f.library.read(artifact.id)).rejects.toMatchObject({ status: 409 });
    } finally { await f.close(); }
  });

  it('rejects symlinked storage and files without reading an external plaintext file', async () => {
    const f = await fixture();
    try {
      const actual = resolve(f.root, 'actual'); await mkdir(actual);
      const linked = resolve(f.root, 'linked'); await symlink(actual, linked);
      await expect(new NovelLibrary(f.database, resolve(linked, 'novel-files')).initialize()).rejects.toThrow('符号链接');
      expect(() => new NovelLibrary(f.database, resolve('/tmp/novel-files'))).toThrow('独立数据目录');
      const value = directory(); await f.library.saveChapter(value, value.chapters[0]!, body);
      const cached = (await f.database.query<{ payload: { fileId: string } }>('SELECT payload FROM novel_chapters LIMIT 1')).rows[0]!.payload;
      const path = resolve(f.root, 'novel-files', `${cached.fileId}.chapter`), external = resolve(f.root, 'external.txt');
      await writeFile(external, body); await unlink(path); await symlink(external, path);
      await expect(f.library.cachedChapter(value, value.chapters[0]!)).rejects.toMatchObject({ status: 409 });
    } finally { await f.close(); }
  });

  it('authenticates metadata, requests, polling and downloads without adding originals to the script shelf', async () => {
    const f = await fixture(); const app = new Hono();
    registerNovelRoutes(app, { library: f.library, manager: f.manager, getWork: id => f.repository.getWork(id),
      identity: async request => request.headers.get('test-user') ? { id: 'member', name: '成员', role: 'member' } : null });
    const headers = { 'test-user': 'member', 'content-type': 'application/json' };
    try {
      for (const path of [`/api/works/${work().id}/original`, `/api/works/${work().id}/original/jobs`, '/api/original-jobs/unknown', '/api/originals/unknown/download']) {
        expect((await app.request(path, path.endsWith('/jobs') ? { method: 'POST', body: '{}' } : undefined)).status).toBe(401);
      }
      expect((await app.request(`/api/works/${work().id}/original/jobs`, { method: 'POST', headers, body: '{"url":"https://evil.example"}' })).status).toBe(400);
      const response = await app.request(`/api/works/${work().id}/original/jobs`, { method: 'POST', headers, body: '{}' });
      expect(response.status).toBe(202); const queued = await response.json();
      expect((await app.request(`/api/original-jobs/${queued.job.id}`, { headers })).status).toBe(200);
      f.manager.start(); await f.manager.waitForIdle();
      const state = await f.manager.status(work().id);
      const download = await app.request(`/api/originals/${state.artifact!.id}/download`, { headers });
      expect(download.status).toBe(200); expect(download.headers.get('content-disposition')).toContain('attachment;');
      expect(await download.text()).toContain(body);
      expect(JSON.stringify(state)).not.toContain(f.root);
      expect((await f.database.query("SELECT tablename FROM pg_tables WHERE tablename='script_bookshelf'")).rows).toEqual([]);
    } finally { await f.close(); }
  });

  it('keeps verified originals in each member shelf and flags a newer version', async () => {
    let count = 2;
    const f = await fixture({ library: { now: () => new Date(count === 2 ? time : '2026-11-14T12:00:00.000Z') } });
    vi.mocked(f.source.directory).mockImplementation(async item => directory(item, count));
    try {
      await f.manager.request(work()); f.manager.start(); await f.manager.waitForIdle();
      const first = (await f.manager.status(work().id)).artifact!;
      await f.library.addToShelf('alice', first.id);
      await expect(f.library.addToShelf('alice', '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ status: 404 });
      await expect(f.library.addToShelf('alice', 'not-a-version')).rejects.toMatchObject({ status: 404 });
      expect(await f.library.shelf('bob')).toEqual([]);
      const [entry] = await f.library.shelf('alice');
      expect(entry).toMatchObject({ artifact: first, downloadedAt: time, latestArtifactId: first.id, work: { id: work().id, title: '原小说测试' } });
      count = 3;
      await f.manager.request(work()); await f.manager.waitForIdle();
      const second = (await f.manager.status(work().id)).artifact!;
      expect(second.id).not.toBe(first.id);
      await f.library.addToShelf('alice', first.id);
      expect(await f.library.shelf('alice')).toMatchObject([{ artifact: { id: first.id }, downloadedAt: '2026-11-14T12:00:00.000Z', latestArtifactId: second.id }]);
      await f.library.addToShelf('bob', first.id);
      await f.library.removeShelf('alice', first.id);
      expect(await f.library.shelf('alice')).toEqual([]);
      expect(await f.library.shelf('bob')).toHaveLength(1);
      expect((await f.library.read(first.id))!.artifact).toEqual(first);
    } finally { await f.close(); }
  });

  it('authenticates original shelf requests and scopes them to the confirmed member', async () => {
    const f = await fixture(); const app = new Hono();
    registerNovelRoutes(app, { library: f.library, manager: f.manager, getWork: id => f.repository.getWork(id),
      identity: async request => { const id = request.headers.get('test-user'); return id ? { id, name: id, role: 'member' } : null; } });
    const as = (id: string) => ({ 'test-user': id, 'content-type': 'application/json' });
    try {
      await f.manager.request(work()); f.manager.start(); await f.manager.waitForIdle();
      const artifactId = (await f.manager.status(work().id)).artifact!.id;
      expect((await app.request('/api/bookshelf/originals')).status).toBe(401);
      expect((await app.request('/api/bookshelf/originals', { method: 'POST', body: JSON.stringify({ artifactId }) })).status).toBe(401);
      expect((await app.request(`/api/bookshelf/originals/${artifactId}`, { method: 'DELETE' })).status).toBe(401);
      expect((await app.request('/api/bookshelf/originals', { method: 'POST', headers: as('alice'), body: JSON.stringify({ artifactId, userId: 'bob' }) })).status).toBe(400);
      expect((await app.request('/api/bookshelf/originals', { method: 'POST', headers: as('alice'), body: JSON.stringify({ artifactId: '00000000-0000-4000-8000-000000000000' }) })).status).toBe(404);
      expect((await app.request('/api/bookshelf/originals', { method: 'POST', headers: as('alice'), body: JSON.stringify({ artifactId }) })).status).toBe(200);
      const shelf = await (await app.request('/api/bookshelf/originals', { headers: as('alice') })).json();
      expect(shelf.map((entry: { artifact: { id: string } }) => entry.artifact.id)).toEqual([artifactId]);
      expect(JSON.stringify(shelf)).not.toContain(f.root);
      expect(await (await app.request('/api/bookshelf/originals', { headers: as('bob') })).json()).toEqual([]);
      expect((await app.request(`/api/bookshelf/originals/${artifactId}`, { method: 'DELETE', headers: as('bob') })).status).toBe(200);
      expect(await f.library.shelf('alice')).toHaveLength(1);
      expect((await app.request(`/api/bookshelf/originals/${artifactId}`, { method: 'DELETE', headers: as('alice') })).status).toBe(200);
      expect(await f.library.shelf('alice')).toEqual([]);
    } finally { await f.close(); }
  });
});

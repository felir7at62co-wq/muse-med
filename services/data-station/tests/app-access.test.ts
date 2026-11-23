import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { CollectionManager } from '../src/server/collection-manager.ts';
import { DataRepository } from '../src/server/repository.ts';
import { ScriptLibrary, MAX_SCRIPT_BYTES } from '../src/server/script-library.ts';
import type { BookshelfItem, CatalogResponse, CollectionBatch, ScriptArtifact, UserIdentity, Work, WorkDetail } from '../src/shared/types.ts';

const base = 'http://127.0.0.1:4317';
const root = resolve(process.cwd(), '.data', `app-access-${randomUUID()}`);
const encoder = new TextEncoder();
const work: Work = {
  id: 'hongguo:9000000000000000077', sourceId: '9000000000000000077', platform: 'hongguo', kind: 'drama',
  title: '权限验收作品', author: '测试作者', description: '测试简介不是剧本。', coverUrl: null,
  sourceUrl: 'https://hongguoduanju.com/', tags: ['年代'], category: '年代', episodeCount: null,
  wordCount: null, serialStatus: null, publishedAt: null, metrics: [{ key: 'heat', label: '热度', value: 100 }],
  rank: 8, rankChange: null, board: '综合榜', origin: 'live', observedAt: '2026-11-13T08:00:00.000Z', sourceUpdatedAt: null,
};
const batch: CollectionBatch = { platform: 'hongguo', works: [work], observedAt: work.observedAt, coverage: '隔离测试数据，不访问平台' };
const scriptBytes = encoder.encode('第1集 内景。\n主角：这是真实上传文件的测试正文。\n'.repeat(1800));

describe('application administrator and member access', () => {
  let database: PGlite;
  let repository: DataRepository;
  let scripts: ScriptLibrary;
  let manager: CollectionManager;
  let application: ReturnType<typeof createApp>;
  let script: ScriptArtifact;

  const open = async () => {
    database = new PGlite(resolve(root, 'database'));
    repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    await repository.ingestBatch(batch);
    manager = new CollectionManager(repository, { hongguo: async () => batch }, (await repository.collectionIntervalHours() ?? 6) * 3_600_000);
    await manager.initialize();
    scripts = new ScriptLibrary(database, resolve(root, 'script-files'));
    await scripts.initialize();
    application = createApp({ repository, manager, scripts, identity: async request => {
      const id = request.headers.get('x-test-user');
      return id ? { id, name: id, role: id === 'admin' ? 'admin' : 'member' } satisfies UserIdentity : null;
    } });
  };

  const request = async (path: string, user: string | null = 'admin', init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (user) headers.set('x-test-user', user);
    if (init.method && !['GET', 'HEAD'].includes(init.method)) {
      headers.set('Origin', base);
      if (!(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    }
    return application.app.request(base + path, { ...init, headers });
  };

  beforeAll(async () => { await mkdir(root, { recursive: true }); await open(); });
  afterAll(async () => { await manager.stop(); await database.close(); await rm(root, { recursive: true, force: true }); });

  it('rejects anonymous API access and returns a stable authenticated session identity', async () => {
    for (const path of ['/api/session', '/api/works', '/api/bookshelf', '/api/admin/settings', '/api/collectors']) {
      expect((await request(path, null)).status).toBe(401);
    }
    const session = await request('/api/session', 'alice');
    expect(await session.json()).toMatchObject({ id: 'alice', name: 'alice', role: 'member', mode: 'local-preview' });
  });

  it('provides a platform-scoped board directory before loading a ranked page', async () => {
    expect(await (await request('/api/boards?platform=hongguo', 'alice')).json()).toEqual({ boards: ['综合榜'], defaultBoard: '综合榜' });
    expect(await (await request('/api/boards?platform=fanqie', 'alice')).json()).toEqual({ boards: [], defaultBoard: null });
    expect((await request('/api/boards?platform=unknown')).status).toBe(400);
    expect((await request('/api/boards?platform=hongguo', null)).status).toBe(401);
  });

  it('allows administrator interval changes and restores them from the reopened database', async () => {
    expect(await (await request('/api/admin/settings')).json()).toMatchObject({ intervalHours: 6 });
    for (const hours of [0, 169, 1.5, '12']) {
      expect((await request('/api/admin/settings', 'admin', { method: 'PUT', body: JSON.stringify({ intervalHours: hours }) })).status).toBe(400);
    }
    const saved = await request('/api/admin/settings', 'admin', { method: 'PUT', body: JSON.stringify({ intervalHours: 12 }) });
    expect(saved.status).toBe(200);
    expect(await repository.collectionIntervalHours()).toBe(12);
    await manager.stop(); await database.close(); await open();
    expect(await repository.collectionIntervalHours()).toBe(12);
    expect(manager.intervalMs).toBe(12 * 3_600_000);
    expect(await (await request('/api/admin/settings')).json()).toMatchObject({ intervalHours: 12 });
  });

  it('keeps collection and settings controls administrator-only while members can read data', async () => {
    expect((await request('/api/admin/settings', 'alice')).status).toBe(403);
    expect((await request('/api/admin/settings', 'alice', { method: 'PUT', body: '{"intervalHours":1}' })).status).toBe(403);
    expect((await request('/api/collectors', 'alice')).status).toBe(403);
    expect((await request('/api/collectors/hongguo/run', 'alice', { method: 'POST', body: '{}' })).status).toBe(403);
    expect((await request('/api/works', 'alice')).status).toBe(200);
    expect(await (await request('/api/bookshelf', 'alice')).json()).toEqual([]);
    const started = await request('/api/collectors/hongguo/run', 'admin', { method: 'POST', body: '{}' });
    expect(started.status).toBe(202);
    await application.waitForCollections();
    expect(await repository.collectionIntervalHours()).toBe(12);
  });

  it('accepts administrator multipart files larger than the JSON limit and publishes real script metadata', async () => {
    const form = new FormData();
    form.set('file', new File([scriptBytes], '权限验收剧本.md', { type: 'text/markdown' }));
    expect(scriptBytes.length).toBeGreaterThan(32_768);
    const member = await request(`/api/works/${encodeURIComponent(work.id)}/script`, 'alice', { method: 'POST', body: form });
    expect(member.status).toBe(403);
    const uploaded = await request(`/api/works/${encodeURIComponent(work.id)}/script`, 'admin', { method: 'POST', body: form });
    expect(uploaded.status).toBe(201);
    script = await uploaded.json() as ScriptArtifact;
    expect(script).toMatchObject({ workId: work.id, fileName: '权限验收剧本.md', byteLength: scriptBytes.length });
    expect(script.sha256).toBe(createHash('sha256').update(scriptBytes).digest('hex'));
    const catalog = await (await request('/api/works', 'alice')).json() as CatalogResponse;
    const detail = await (await request(`/api/works/${encodeURIComponent(work.id)}`, 'alice')).json() as WorkDetail;
    expect(catalog.items.find(item => item.id === work.id)?.script?.id).toBe(script.id);
    expect(detail.work.script?.id).toBe(script.id);
    expect(JSON.stringify(script)).not.toContain('script-files');
  });

  it('retains the JSON body limit and rejects oversized files without replacing the current script', async () => {
    const oversizedJson = await request('/api/admin/settings', 'admin', { method: 'PUT', body: JSON.stringify({ intervalHours: 12, padding: 'x'.repeat(33_000) }) });
    expect(oversizedJson.status).toBe(413);
    const large = new FormData();
    large.set('file', new File([new Uint8Array(MAX_SCRIPT_BYTES + 1)], '过大.txt', { type: 'text/plain' }));
    expect((await request(`/api/works/${encodeURIComponent(work.id)}/script`, 'admin', { method: 'POST', body: large })).status).toBe(413);
    expect((await scripts.current(work.id))?.id).toBe(script.id);
  });

  it('downloads original bytes and only adds the file to the requesting member shelf after confirmation', async () => {
    expect((await request('/api/scripts/00000000-0000-0000-0000-000000000000/download', 'alice')).status).toBe(404);
    expect(await scripts.shelf('alice')).toEqual([]);
    const response = await request(`/api/scripts/${script.id}/download`, 'alice');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(response.headers.get('content-length')).toBe(String(scriptBytes.length));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(scriptBytes);
    expect(await scripts.shelf('alice')).toEqual([]);
    const added = await request('/api/bookshelf', 'alice', { method: 'POST', body: JSON.stringify({ scriptId: script.id }) });
    expect(added.status).toBe(200);
    const alice = await (await request('/api/bookshelf', 'alice')).json() as BookshelfItem[];
    const bob = await (await request('/api/bookshelf', 'bob')).json() as BookshelfItem[];
    expect(alice[0]?.script.id).toBe(script.id);
    expect(bob).toEqual([]);
    await request(`/api/bookshelf/${script.id}`, 'bob', { method: 'DELETE' });
    expect((await scripts.shelf('alice'))[0]?.script.id).toBe(script.id);
  });
});

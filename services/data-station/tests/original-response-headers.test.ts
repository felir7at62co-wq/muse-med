import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { createTrustedProxyIdentity } from '../src/server/identity.ts';
import { CoverCache } from '../src/server/covers.ts';
import { DataRepository } from '../src/server/repository.ts';
import { NovelLibrary } from '../src/server/novels/library.ts';
import { NovelDownloadManager } from '../src/server/novels/manager.ts';
import type { NovelArtifact } from '../src/shared/novels.ts';
import type { Work } from '../src/shared/types.ts';

const secret = 'c2'.repeat(32);
const origin = 'https://muse.aigc-pipeline.cn';
const local = 'http://127.0.0.1:19618';
const observedAt = '2026-11-13T15:00:00.000Z';
const body = '这里是专用于独立响应头回归的完整章节正文。';
const item: Work = { id: 'fanqie:7000000000000000001', sourceId: '7000000000000000001', platform: 'fanqie', kind: 'novel', title: '原文响应检查', author: '测试作者',
  description: '仅隔离测试资料', coverUrl: 'https://p6-novel.byteimg.com/novel-pic/isolated-test.jpg', sourceUrl: 'https://fanqienovel.com/page/7000000000000000001',
  tags: [], category: '', episodeCount: null, wordCount: null, serialStatus: '已完结', publishedAt: null, metrics: [], rank: null, rankChange: null,
  board: '', origin: 'live', observedAt, sourceUpdatedAt: null };
const authenticated = { 'X-Muse-Data-Key': secret, 'X-Muse-Data-User': 'member', Origin: origin };

function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
}

describe('original binary downloads through the complete authenticated application', () => {
  let directory: string, database: PGlite, library: NovelLibrary, manager: NovelDownloadManager;
  let app: ReturnType<typeof createApp>['app'];
  let artifact: NovelArtifact;
  beforeAll(async () => {
    await mkdir(resolve('.data'), { recursive: true });
    directory = await realpath(await mkdtemp(resolve('.data/original-response-test-')));
    database = new PGlite();
    const repository = new DataRepository(database); await repository.initialize({ seedDemo: false });
    await repository.ingestBatch({ platform: 'fanqie', works: [item], observedAt, coverage: 'Independent binary response regression fixture only' });
    library = new NovelLibrary(database, join(directory, 'novel-files')); await library.initialize();
    const source = library.validateDirectory({ workId: item.id, sourceId: item.sourceId, platform: 'fanqie', title: item.title!, author: item.author,
      sourceUrl: item.sourceUrl, observedAt, declaredChapterCount: 1, finished: true, chapters: [{ id: '1001', index: 1, title: '第一章',
        sourceUrl: 'https://fanqienovel.com/reader/1001', wordCount: [...body].length, sourceUpdatedAt: null }] }, item);
    await library.saveChapter(source, source.chapters[0]!, body); artifact = await library.publish(source);
    manager = new NovelDownloadManager(repository, library, {}); await manager.initialize();
    const identityFile = join(directory, 'identity.json');
    await writeFile(identityFile, JSON.stringify({ version: 1, proxySecret: secret, users: [
      { username: 'member', id: 'stable-member', name: '成员', role: 'member' },
    ] }), { mode: 0o600 });
    const identity = await createTrustedProxyIdentity(identityFile);
    app = createApp({ repository, identity, mode: 'server', publicOrigin: origin, port: 19618, novels: { library, manager },
      covers: new CoverCache(async () => ({ body: new Uint8Array([255, 216, 255, 0]), contentType: 'image/jpeg' })) }).app;
  });
  afterAll(async () => { await manager?.stop(); await database?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  it('preserves confirmed identity and security headers on the actual immutable TXT response without changing its bytes', async () => {
    const response = await app.request(`${local}/api/originals/${artifact.id}/download`, { headers: authenticated });
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Muse-Data-Authenticated')).toBe('1');
    expectSecurityHeaders(response);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('Content-Length')).toBe(String(artifact.byteLength));
    expect(response.headers.get('Content-Disposition')).toContain('attachment;');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBe(artifact.byteLength);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
    expect(new TextDecoder().decode(bytes)).toContain(body);
  });

  it('refuses an unauthenticated binary download without marking it confirmed or returning original text', async () => {
    const response = await app.request(`${local}/api/originals/${artifact.id}/download`);
    expect(response.status).toBe(401); expect(response.headers.get('X-Muse-Data-Authenticated')).toBeNull();
    expectSecurityHeaders(response); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).not.toContain(body);
  });

  it('keeps member management denials and CSRF early returns confirmed', async () => {
    const denied = await app.request(`${local}/api/admin/settings`, { headers: authenticated });
    expect(denied.status).toBe(403); expect(denied.headers.get('X-Muse-Data-Authenticated')).toBe('1'); expectSecurityHeaders(denied);
    const crossSite = await app.request(`${local}/api/originals/${artifact.id}/download`, { headers: { ...authenticated, Origin: 'https://evil.example' } });
    expect(crossSite.status).toBe(403); expect(crossSite.headers.get('X-Muse-Data-Authenticated')).toBe('1'); expectSecurityHeaders(crossSite);
  });

  it('preserves the cover route cache policy while applying the same confirmed identity and security headers', async () => {
    const response = await app.request(`${local}/api/covers/${encodeURIComponent(item.id)}`, { headers: authenticated });
    expect(response.status).toBe(200); expect(response.headers.get('X-Muse-Data-Authenticated')).toBe('1'); expectSecurityHeaders(response);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=21600');
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([255, 216, 255, 0]));
  });
});

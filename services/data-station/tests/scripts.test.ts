import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Hono } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { MAX_SCRIPT_BYTES, ScriptLibrary } from '../src/server/script-library.ts';
import { registerScriptRoutes } from '../src/server/script-routes.ts';
import type { ScriptArtifact, UserIdentity, Work, WorkDetail } from '../src/shared/types.ts';

const workId = 'hongguo:9000000000000000011';
const otherWorkId = 'hongguo:9000000000000000022';
const encoder = new TextEncoder();
const root = resolve(process.cwd(), '.data', `script-tests-${randomUUID()}`);
const directory = resolve(root, 'script-files');
const bytes = encoder.encode('第1集\n内景。主角收到一封来信。\n');
function work(id = workId): Work {
  return { id, sourceId: id.split(':')[1]!, platform: 'hongguo', kind: 'drama', title: '测试作品', author: null,
    description: '作品简介不能冒充剧本', coverUrl: null, sourceUrl: 'https://hongguoduanju.com/',
    tags: [], category: '都市', episodeCount: null, wordCount: null, serialStatus: null, publishedAt: null,
    metrics: [{ key: 'heat', label: '热度', value: 100 }], rank: 5, rankChange: null,
    board: '综合榜', origin: 'live', observedAt: '2026-11-13T08:00:00.000Z', sourceUpdatedAt: null };
}
function validDocx(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" /></Types>'),
    'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>真实上传剧本</w:t></w:r></w:p></w:body></w:document>'),
  });
}

describe('immutable script files and personal shelves', () => {
  let database: PGlite;
  let library: ScriptLibrary;
  let first: ScriptArtifact;
  const app = new Hono();
  beforeAll(async () => {
    database = new PGlite();
    await database.exec('CREATE TABLE works(id text PRIMARY KEY,payload jsonb NOT NULL)');
    for (const item of [work(), work(otherWorkId)]) await database.query('INSERT INTO works(id,payload) VALUES($1,$2::jsonb)', [item.id, JSON.stringify(item)]);
    library = new ScriptLibrary(database, directory);
    await library.initialize();
    registerScriptRoutes(app, {
      library,
      identity: async request => {
        const id = request.headers.get('test-user');
        if (!id) return null;
        return { id, name: id, role: id === 'admin' ? 'admin' : 'member' } satisfies UserIdentity;
      },
      getWork: async id => {
        const result = await database.query<{ payload: Work }>('SELECT payload FROM works WHERE id=$1', [id]);
        return result.rows[0] ? { work: result.rows[0].payload, observations: [], selection: null } satisfies WorkDetail : null;
      },
    });
  });
  afterAll(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });

  it('stores and downloads the exact uploaded bytes with an integrity digest', async () => {
    first = await library.put(workId, '剧本第一版.md', bytes, 'text/markdown');
    expect(first).toMatchObject({ workId, fileName: '剧本第一版.md', byteLength: bytes.length, contentType: 'text/markdown' });
    expect(first.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect((await library.read(first.id))?.bytes).toEqual(bytes);
    expect(JSON.stringify(first)).not.toContain('script-files');
    expect(await library.current('missing')).toBeNull();
  });

  it('keeps changed versions and returns the original artifact for a retried content upload', async () => {
    const second = await library.put(workId, '剧本第二版.md', encoder.encode('第1集\n修改后的真实上传版本。'), 'text/markdown');
    expect(second.id).not.toBe(first.id);
    expect((await library.current(workId))?.id).toBe(second.id);
    expect((await library.read(first.id))?.bytes).toEqual(bytes);
    expect((await library.put(workId, '重传文件.md', bytes, 'text/markdown')).id).toBe(first.id);
    expect((await library.current(workId))?.id).toBe(second.id);
    expect((await library.metadataForWorks([workId, 'missing']))[workId]?.id).toBe(second.id);
  });

  it('deduplicates simultaneous same-work, same-content retries', async () => {
    const result = await Promise.all([1, 2].map(() => library.put(otherWorkId, '并发.txt', bytes, 'text/plain')));
    expect(result[0]?.id).toBe(result[1]?.id);
    const rows = await database.query<{ count: number }>('SELECT count(*)::int AS count FROM script_artifacts WHERE work_id=$1', [otherWorkId]);
    expect(rows.rows[0]?.count).toBe(1);
  });

  it('rejects missing works, filename escapes, empty files and disguised file formats', async () => {
    await expect(library.put('missing', 'a.txt', bytes, 'text/plain')).rejects.toMatchObject({ status: 404 });
    for (const name of ['../../escape.txt', '..\\escape.txt', 'a.exe', 'a\r\n.txt']) await expect(library.put(workId, name, bytes, 'text/plain')).rejects.toThrow();
    await expect(library.put(workId, 'a.txt', new Uint8Array(), 'text/plain')).rejects.toThrow(/空剧本/);
    await expect(library.put(workId, 'a.txt', new Uint8Array(MAX_SCRIPT_BYTES + 1), 'text/plain')).rejects.toMatchObject({ status: 413 });
    await expect(library.put(workId, 'a.pdf', bytes, 'application/pdf')).rejects.toThrow(/PDF/);
    await expect(library.put(workId, 'a.txt', new Uint8Array([0xff, 0x00]), 'text/plain')).rejects.toThrow();
    await expect(library.put(workId, 'a.md', bytes, 'application/pdf')).rejects.toThrow(/扩展名/);
  });

  it('checks DOCX content parts and does not unzip unexpected or oversized XML', async () => {
    const pdf = encoder.encode('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
    const pdfArtifact = await library.put(workId, '上传.pdf', pdf, 'application/pdf');
    expect((await library.read(pdfArtifact.id))?.bytes).toEqual(pdf);
    const docx = validDocx();
    const artifact = await library.put(workId, '上传.docx', docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect((await library.read(artifact.id))?.bytes).toEqual(docx);
    await expect(library.put(workId, '假文件.docx', zipSync({ 'a.txt': bytes }), '')).rejects.toThrow(/缺少文档/);
    const bomb = zipSync({ 'word/document.xml': new Uint8Array(2 * 1024 * 1024 + 1) });
    await expect(library.put(workId, '过大.docx', bomb, '')).rejects.toThrow(/大小限制/);
    const macro = zipSync({ 'word/vbaProject.bin': bytes });
    await expect(library.put(workId, '宏.docx', macro, '')).rejects.toThrow(/结构无效/);
  });

  it('authenticates all routes and restricts real uploads to administrators', async () => {
    expect((await app.request('/api/bookshelf')).status).toBe(401);
    expect((await app.request(`/api/scripts/${first.id}/download`)).status).toBe(401);
    const form = new FormData(); form.set('file', new File([bytes], '用户剧本.md', { type: 'text/markdown' }));
    expect((await app.request(`/api/works/${workId}/script`, { method: 'POST', headers: { 'test-user': 'alice' }, body: form })).status).toBe(403);
    const uploaded = await app.request(`/api/works/${workId}/script`, { method: 'POST', headers: { 'test-user': 'admin' }, body: form });
    expect(uploaded.status).toBe(201);
    expect((await uploaded.json()).sha256).toBe(first.sha256);
  });

  it('does not add failed or successful downloads to a shelf without a separate confirmation', async () => {
    const headers = { 'test-user': 'alice' };
    const failed = await app.request('/api/scripts/00000000-0000-0000-0000-000000000000/download', { headers });
    expect(failed.status).toBe(404);
    expect(await library.shelf('alice')).toEqual([]);
    const downloaded = await app.request(`/api/scripts/${first.id}/download`, { headers });
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
    expect(downloaded.headers.get('content-disposition')).toContain('attachment;');
    expect(await library.shelf('alice')).toEqual([]);
    const response = await app.request('/api/bookshelf', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ scriptId: first.id }) });
    expect(response.status).toBe(200);
    expect((await library.shelf('alice'))[0]?.script.id).toBe(first.id);
  });

  it('isolates shelves and joins updated platform metrics without changing the stored file', async () => {
    expect(await library.shelf('bob')).toEqual([]);
    await library.addToShelf('bob', first.id);
    const updated = { ...work(), metrics: [{ key: 'heat', label: '热度', value: 9999 }], rank: 1 };
    await database.query('UPDATE works SET payload=$2::jsonb WHERE id=$1', [workId, JSON.stringify(updated)]);
    expect((await library.shelf('alice'))[0]?.work.metrics[0]?.value).toBe(9999);
    expect((await library.shelf('alice'))[0]?.script.sha256).toBe(first.sha256);
    await app.request(`/api/bookshelf/${first.id}`, { method: 'DELETE', headers: { 'test-user': 'alice' } });
    expect(await library.shelf('alice')).toEqual([]);
    expect((await library.shelf('bob'))[0]?.script.id).toBe(first.id);
    expect((await library.read(first.id))?.bytes).toEqual(bytes);
  });

  it('refuses directory escapes and symlinked storage', async () => {
    expect(() => new ScriptLibrary(database, resolve(root, '..', '..', '..', 'script-files'))).toThrow(/独立数据目录/);
    const target = resolve(root, 'actual'); await mkdir(target);
    const link = resolve(root, 'linked'); await symlink(target, link);
    await expect(new ScriptLibrary(database, resolve(link, 'script-files')).initialize()).rejects.toThrow(/符号链接/);
  });

  it('refuses a tampered file before download or bookshelf insertion succeeds', async () => {
    const artifact = await library.put(workId, '破坏检测.txt', encoder.encode('原文内容。'), 'text/plain');
    const path = resolve(directory, `${artifact.id}.bin`);
    const original = await readFile(path);
    await writeFile(path, new Uint8Array(original.byteLength).fill(65));
    expect((await app.request(`/api/scripts/${artifact.id}/download`, { headers: { 'test-user': 'bob' } })).status).toBe(409);
    await expect(library.addToShelf('bob', artifact.id)).rejects.toThrow(/校验失败/);
    expect((await library.shelf('bob')).some(item => item.script.id === artifact.id)).toBe(false);
  });
});

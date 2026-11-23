import type { Hono } from 'hono';
import { z } from 'zod';
import type { UserIdentity, WorkDetail } from '../../shared/types.ts';
import { NovelFileError, type NovelLibrary } from './library.ts';
import type { NovelDownloadManager } from './manager.ts';
import { NovelSourceError } from './source.ts';

/** Registers authenticated original-novel metadata, independent download jobs, verified TXT downloads and per-member original shelves. */
export function registerNovelRoutes(app: Hono, options: {
  manager: NovelDownloadManager;
  library: NovelLibrary;
  identity: (request: Request) => Promise<UserIdentity | null>;
  getWork: (id: string) => Promise<WorkDetail | null>;
}): void {
  const errors = async (operation: () => Promise<Response>, json: (value: { error: string }, status: 400 | 404 | 409 | 413 | 429 | 422) => Response) => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof NovelFileError) return json({ error: error.message }, error.status);
      if (error instanceof NovelSourceError) return json({ error: error.code === 'authorization_required' ? '原文来源要求授权' : '该作品原文暂不可用' }, 422);
      if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: '原文请求参数无效' }, 400);
      throw error;
    }
  };
  for (const path of ['/api/works/:id/original', '/api/works/:id/original/jobs', '/api/original-jobs/:id', '/api/originals/:id/download', '/api/bookshelf/originals', '/api/bookshelf/originals/:id']) {
    app.use(path, async (c, next) => { if (!await options.identity(c.req.raw)) return c.json({ error: '请先登录' }, 401); await next(); });
  }
  app.get('/api/works/:id/original', c => errors(async () => {
    if (!await options.getWork(c.req.param('id'))) return c.json({ error: '作品不存在' }, 404);
    return c.json(await options.manager.status(c.req.param('id')));
  }, (value, status) => c.json(value, status)));
  app.post('/api/works/:id/original/jobs', c => errors(async () => {
    z.object({}).strict().parse(await c.req.json());
    const detail = await options.getWork(c.req.param('id'));
    if (!detail) return c.json({ error: '作品不存在' }, 404);
    return c.json(await options.manager.request(detail.work), 202);
  }, (value, status) => c.json(value, status)));
  app.get('/api/original-jobs/:id', c => errors(async () => {
    const job = await options.manager.job(c.req.param('id'));
    return job ? c.json(job) : c.json({ error: '原文任务不存在' }, 404);
  }, (value, status) => c.json(value, status)));
  app.get('/api/bookshelf/originals', async c => c.json(await options.library.shelf((await options.identity(c.req.raw))!.id)));
  app.post('/api/bookshelf/originals', c => errors(async () => {
    const { artifactId } = z.object({ artifactId: z.string().uuid() }).strict().parse(await c.req.json());
    await options.library.addToShelf((await options.identity(c.req.raw))!.id, artifactId);
    return c.json({ added: true });
  }, (value, status) => c.json(value, status)));
  app.delete('/api/bookshelf/originals/:id', async c => {
    await options.library.removeShelf((await options.identity(c.req.raw))!.id, c.req.param('id'));
    return c.json({ removed: true });
  });
  app.get('/api/originals/:id/download', c => errors(async () => {
    const file = await options.library.read(c.req.param('id'));
    if (!file) return c.json({ error: '原文文件不存在' }, 404);
    const filename = encodeURIComponent(file.artifact.fileName).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(new Uint8Array(file.bytes), { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(file.bytes.byteLength),
      'content-disposition': `attachment; filename="original-novel.txt"; filename*=UTF-8''${filename}`,
      'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } });
  }, (value, status) => c.json(value, status)));
}

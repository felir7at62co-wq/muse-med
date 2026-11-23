import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { UserIdentity, WorkDetail } from '../shared/types.ts';
import { MAX_SCRIPT_BYTES, ScriptFileError, type ScriptLibrary } from './script-library.ts';

function safeError(error: unknown, context: Context): Response {
  if (error instanceof ScriptFileError) return context.json({ error: error.message }, error.status);
  if (error instanceof z.ZodError || error instanceof TypeError || error instanceof SyntaxError) return context.json({ error: '请求参数或文件格式无效' }, 400);
  throw error;
}

/** Registers authenticated file downloads, administrator uploads, and per-user shelves. */
export function registerScriptRoutes(app: Hono, options: {
  library: ScriptLibrary;
  identity: (request: Request) => Promise<UserIdentity | null>;
  getWork: (id: string) => Promise<WorkDetail | null>;
}): void {
  app.get('/api/bookshelf', async c => {
    const user = await options.identity(c.req.raw);
    if (!user) return c.json({ error: '请先登录' }, 401);
    return c.json(await options.library.shelf(user.id));
  });
  app.post('/api/bookshelf', async c => {
    const user = await options.identity(c.req.raw);
    if (!user) return c.json({ error: '请先登录' }, 401);
    try {
      const { scriptId } = z.object({ scriptId: z.string().uuid() }).strict().parse(await c.req.json());
      await options.library.addToShelf(user.id, scriptId);
      return c.json({ added: true });
    } catch (error) { return safeError(error, c); }
  });
  app.delete('/api/bookshelf/:scriptId', async c => {
    const user = await options.identity(c.req.raw);
    if (!user) return c.json({ error: '请先登录' }, 401);
    await options.library.removeShelf(user.id, c.req.param('scriptId'));
    return c.json({ removed: true });
  });
  app.get('/api/scripts/:id/download', async c => {
    const user = await options.identity(c.req.raw);
    if (!user) return c.json({ error: '请先登录' }, 401);
    try {
      const result = await options.library.read(c.req.param('id'));
      if (!result) return c.json({ error: '剧本文件不存在' }, 404);
      const extension = result.artifact.fileName.split('.').at(-1) || 'txt';
      const encoded = encodeURIComponent(result.artifact.fileName).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
      return c.body(new Uint8Array(result.bytes), 200, {
        'Content-Type': result.artifact.contentType,
        'Content-Length': String(result.bytes.byteLength),
        'Content-Disposition': `attachment; filename="script-${result.artifact.id}.${extension}"; filename*=UTF-8''${encoded}`,
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      });
    } catch (error) { return safeError(error, c); }
  });
  app.post('/api/works/:id/script', async c => {
    const user = await options.identity(c.req.raw);
    if (!user) return c.json({ error: '请先登录' }, 401);
    if (user.role !== 'admin') return c.json({ error: '只有管理员可以上传剧本' }, 403);
    if (!await options.getWork(c.req.param('id'))) return c.json({ error: '作品不存在' }, 404);
    if (!c.req.header('content-type')?.toLowerCase().startsWith('multipart/form-data;')) return c.json({ error: '请上传 multipart/form-data 文件' }, 415);
    try {
      const body = await c.req.formData();
      const file = body.get('file');
      if (!(file instanceof File)) return c.json({ error: '请选择剧本文件' }, 400);
      if (file.size > MAX_SCRIPT_BYTES) return c.json({ error: '剧本文件不能超过 20 MiB' }, 413);
      const artifact = await options.library.put(c.req.param('id'), file.name, new Uint8Array(await file.arrayBuffer()), file.type);
      return c.json(artifact, 201);
    } catch (error) { return safeError(error, c); }
  });
}

/**
 * HTTP routes of the daily hit-transcription loop.
 * `/api/hits/*` serve signed-in members (储备看板, 立即转写); `/api/service/*` serve the transcription worker with the
 * service token only. The global middleware in app.ts authenticates both families.
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { ACTIVE_JOB_STATES, type ClaimedWork, type ClaimReview, type HitBoard, type HitBoardFilter, type HitBoardItem, type HitWorkSummary, type JobChecks, type TranscriptionJob } from '../../shared/hits.ts';
import { displayName, type ScriptArtifact, type UserIdentity, type Work } from '../../shared/types.ts';
import type { DataRepository } from '../repository.ts';
import { MAX_SCRIPT_BYTES, ScriptFileError, type ScriptLibrary } from '../script-library.ts';
import { ruleSummary } from './rules.ts';
import type { HitSelector } from './selector.ts';
import type { ServiceIdentity } from './service-auth.ts';
import { failureSchema, HitJobError, progressSchema, tosUploadSchema, type HitStore } from './store.ts';

export interface HitRouteOptions {
  store: HitStore;
  selector: Pick<HitSelector, 'status' | 'request' | 'ruleSet' | 'setTopic' | 'topicChecks'>;
  repository: DataRepository;
  scripts?: ScriptLibrary;
  identity: (request: Request) => Promise<UserIdentity | null>;
  service?: ServiceIdentity;
}

const lease = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const workerId = z.string().trim().min(1).max(200).refine(value => !/[\p{Cc}]/u.test(value));
const boardQuery = z.object({
  filter: z.enum(['all', 'script', 'active', 'queued', 'failed', 'rejected']).default('all'),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
const checksSchema = z.object({ passed: z.boolean(), summary: z.string().max(2_000).nullish() }).passthrough();

/** Accepts `hongguo:<id>` or a bare series ID. */
function workIdOf(value: string): string {
  const id = /^\d{1,30}$/.test(value) ? `hongguo:${value}` : value;
  if (!/^hongguo:\d{1,30}$/.test(id)) throw new HitJobError('只支持红果作品 ID', 400);
  return id;
}

function failure(error: unknown, c: Context): Response {
  if (error instanceof HitJobError || error instanceof ScriptFileError) return c.json({ error: error.message }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: '请求参数无效', issues: error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).slice(0, 10) : undefined }, 400);
  throw error;
}

function summaryOf(work: Work): HitWorkSummary {
  return { id: work.id, sourceId: work.sourceId, title: work.title, coverUrl: work.coverUrl, sourceUrl: work.sourceUrl, tags: work.tags,
    episodeCount: work.episodeCount, board: work.board, observedAt: work.observedAt };
}

const stateRank = (item: HitBoardItem): number => {
  const state = item.job?.state;
  if (!state) return 4;
  if ((ACTIVE_JOB_STATES as readonly string[]).includes(state)) return 0;
  return state === 'queued' ? 1 : state === 'published' ? 3 : 2;
};

/** Assembles the 储备看板: every job, every qualifying candidate and every Hongguo drama with a script. */
export async function buildHitBoard(options: Pick<HitRouteOptions, 'store' | 'selector' | 'repository' | 'scripts'>, query: z.infer<typeof boardQuery>): Promise<HitBoard> {
  const [jobs, qualified, summary, works] = await Promise.all([options.store.jobs(), options.store.qualifiedIds(),
    options.store.summary(), options.repository.liveWorks('hongguo')]);
  const byId = new Map(works.map(work => [work.id, work]));
  const ids = new Set([...jobs.map(job => job.workId), ...qualified, ...await options.scripts?.workIdsWithScripts('hongguo:') ?? []]);
  const [candidates, scripts] = await Promise.all([options.store.candidatesFor([...ids]), options.scripts?.metadataForWorks([...ids]) ?? Promise.resolve<Record<string, ScriptArtifact>>({})]);
  const jobOf = new Map(jobs.map((job, index) => [job.workId, { job, index }]));
  const q = query.q?.trim().toLocaleLowerCase();
  let items: (HitBoardItem & { order: number })[] = [];
  for (const id of ids) {
    const work = byId.get(id);
    if (!work) continue;
    if (q && !`${work.title ?? ''} ${work.sourceId}`.toLocaleLowerCase().includes(q)) continue;
    const held = jobOf.get(id);
    items.push({ work: summaryOf(work), evaluation: candidates.get(id)?.evaluation ?? null, job: held?.job ?? null, script: scripts[id] ?? null, order: held?.index ?? Number.MAX_SAFE_INTEGER });
  }
  const filters: Record<HitBoardFilter, (item: HitBoardItem) => boolean> = {
    all: () => true, script: item => item.script !== null, active: item => stateRank(item) === 0,
    queued: item => item.job?.state === 'queued', failed: item => item.job?.state === 'failed' || item.job?.state === 'needs-attention',
    rejected: item => item.job?.state === 'rejected',
  };
  items = items.filter(filters[query.filter]).sort((a, b) => stateRank(a) - stateRank(b)
    || (stateRank(a) === 3 ? (b.job!.publishedAt ?? '').localeCompare(a.job!.publishedAt ?? '') : 0)
    || (stateRank(a) === 4 ? (b.evaluation?.collection?.value ?? 0) - (a.evaluation?.collection?.value ?? 0) : 0)
    || a.order - b.order || a.work.id.localeCompare(b.work.id));
  const page = items.slice((query.page - 1) * query.limit, query.page * query.limit).map(({ order: _order, ...item }) => item);
  return { summary, rules: ruleSummary(options.selector.ruleSet), items: page, total: items.length, page: query.page, limit: query.limit,
    filter: query.filter, selection: options.selector.status(), generatedAt: new Date().toISOString() };
}

/**
 * The drama a worker just claimed, with every tag and the full description, and whether it must run the 选材复核.
 * A member's 立即转写 (manual lane) and a job a previous worker already accepted (has progress) skip the review.
 */
async function claimContext(options: Pick<HitRouteOptions, 'store' | 'selector' | 'repository'>, job: TranscriptionJob): Promise<{ work: ClaimedWork | null; review: ClaimReview }> {
  const rules = options.selector.ruleSet.review;
  const review = { required: rules.enabled && job.lane !== 'manual' && job.progress === null, standard: rules.standard };
  const work = (await options.repository.liveWorks('hongguo')).find(item => item.id === job.workId);
  if (!work) return { work: null, review };
  const evaluation = (await options.store.candidatesFor([job.workId])).get(job.workId)?.evaluation ?? null;
  const description = work.description || (await options.store.detail(job.workId))?.reading?.description || '';
  const collection = evaluation?.collection?.value ?? work.metrics.find(metric => metric.key === 'collection')?.value ?? null;
  const topic = evaluation?.douyin;
  return { review, work: {
    title: work.title, category: work.category, tags: work.tags, description, episodes: work.episodeCount, collection,
    douyinTopic: topic && (topic.state === 'pass' || topic.state === 'below') ? { name: topic.topicName, views: topic.viewCount } : null,
    ipMatch: evaluation?.ip.level ?? 'none',
    evaluation: evaluation ? { score: evaluation.sink.score, strongHits: evaluation.sink.strongHits, blockHits: evaluation.sink.blockHits, directions: evaluation.sink.directions } : null,
  } };
}

/** Registers member, administrator and service routes. */
export function registerHitRoutes(app: Hono, options: HitRouteOptions): void {
  const { store } = options;
  app.get('/api/hits/board', async c => {
    try { return c.json(await buildHitBoard(options, boardQuery.parse(c.req.query()))); }
    catch (error) { return failure(error, c); }
  });
  app.post('/api/hits/:workId/rush', async c => {
    const user = await options.identity(c.req.raw);
    if (!user) return c.json({ error: '请先登录' }, 401);
    try {
      z.object({}).strict().parse(await c.req.json());
      const workId = workIdOf(c.req.param('workId'));
      const work = (await options.repository.liveWorks('hongguo')).find(item => item.id === workId);
      if (!work) return c.json({ error: '作品不存在' }, 404);
      const candidate = (await store.candidatesFor([workId])).get(workId);
      const job = await store.rush(workId, displayName(user), { qualifiedAt: candidate?.qualified ? candidate.firstQualifiedAt : null, priority: candidate?.evaluation.collection?.value ?? null });
      return c.json(job);
    } catch (error) { return failure(error, c); }
  });
  /** A person attaches the right Douyin topic when search found none or the wrong one; its counts are read at once. */
  app.post('/api/hits/:workId/douyin-topic', async c => {
    const user = await options.identity(c.req.raw);
    if (!user) return c.json({ error: '请先登录' }, 401);
    if (!options.selector.topicChecks) return c.json({ error: '抖音话题查询尚未配置' }, 503);
    try {
      const { hashtagId } = z.object({ hashtagId: z.string().trim().regex(/^\d{1,32}$/) }).strict().parse(await c.req.json());
      const workId = workIdOf(c.req.param('workId'));
      const work = (await options.repository.liveWorks('hongguo')).find(item => item.id === workId);
      if (!work?.title) return c.json({ error: '作品不存在' }, 404);
      const check = await options.selector.setTopic(workId, work.title, hashtagId);
      options.selector.request();
      return c.json(check);
    } catch (error) { return failure(error, c); }
  });
  app.post('/api/admin/hits/run', async c => {
    if ((await options.identity(c.req.raw))?.role !== 'admin') return c.json({ error: '只有管理员可以启动选片' }, 403);
    z.object({}).strict().parse(await c.req.json());
    if (!options.selector.request()) return c.json({ error: '选片正在进行，请稍候' }, 409);
    return c.json({ started: true }, 202);
  });
  app.get('/api/hits/jobs/:workId/events', async c => {
    try { return c.json(await store.events(workIdOf(c.req.param('workId')))); }
    catch (error) { return failure(error, c); }
  });

  if (!options.service) return;
  app.get('/api/service/hits/candidates', async c => {
    try {
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }).strict().parse(c.req.query());
      const jobs = await store.jobs();
      return c.json({ queued: (await store.queue(limit)), active: jobs.filter(job => (ACTIVE_JOB_STATES as readonly string[]).includes(job.state)),
        counts: Object.fromEntries(['queued', ...ACTIVE_JOB_STATES, 'published', 'failed', 'needs-attention'].map(state => [state, jobs.filter(job => job.state === state).length])),
        selection: options.selector.status() });
    } catch (error) { return failure(error, c); }
  });
  app.post('/api/service/hits/claim', async c => {
    try {
      const input = z.object({ workerId, workId: z.string().max(60).optional() }).strict().parse(await c.req.json());
      const claimed = await store.claim({ workerId: input.workerId, ...(input.workId ? { workId: workIdOf(input.workId) } : {}) });
      if (!claimed) return c.json({ job: null, lease: null, work: null, review: null });
      return c.json({ ...claimed, ...await claimContext(options, claimed.job) });
    } catch (error) { return failure(error, c); }
  });
  app.get('/api/service/hits/jobs/:workId', async c => {
    try {
      const job = await store.job(workIdOf(c.req.param('workId')));
      return job ? c.json(job) : c.json({ error: '这部剧没有转写任务' }, 404);
    } catch (error) { return failure(error, c); }
  });
  app.post('/api/service/hits/jobs/:workId/progress', async c => {
    try {
      const body = progressSchema.and(z.object({ lease })).parse(await c.req.json());
      const { lease: held, ...progress } = body;
      return c.json(await store.progress(workIdOf(c.req.param('workId')), held, progress));
    } catch (error) { return failure(error, c); }
  });
  app.put('/api/service/hits/jobs/:workId/videos', async c => {
    try {
      const body = z.object({ lease, upload: tosUploadSchema }).strict().parse(await c.req.json());
      return c.json(await store.recordVideos(workIdOf(c.req.param('workId')), body.lease, body.upload));
    } catch (error) { return failure(error, c); }
  });
  app.post('/api/service/hits/jobs/:workId/reject', async c => {
    try {
      const body = z.object({ lease, reason: z.string().trim().min(1).max(500) }).strict().parse(await c.req.json());
      return c.json(await store.reject(workIdOf(c.req.param('workId')), body.lease, body.reason));
    } catch (error) { return failure(error, c); }
  });
  app.post('/api/service/hits/jobs/:workId/fail', async c => {
    try {
      const body = failureSchema.and(z.object({ lease })).parse(await c.req.json());
      const { lease: held, ...input } = body;
      return c.json(await store.fail(workIdOf(c.req.param('workId')), held, input));
    } catch (error) { return failure(error, c); }
  });
  app.post('/api/service/hits/jobs/:workId/script', async c => {
    if (!options.scripts) return c.json({ error: '剧本库未启用' }, 503);
    if (!c.req.header('content-type')?.toLowerCase().startsWith('multipart/form-data;')) return c.json({ error: '请上传 multipart/form-data 文件' }, 415);
    try {
      const workId = workIdOf(c.req.param('workId'));
      const form = await c.req.formData();
      const held = lease.parse(form.get('lease'));
      const file = form.get('file');
      if (!(file instanceof File)) return c.json({ error: '缺少剧本文件 file' }, 400);
      if (file.size > MAX_SCRIPT_BYTES) return c.json({ error: '剧本文件不能超过 20 MiB' }, 413);
      const rawChecks = form.get('checks');
      const parsedChecks = typeof rawChecks === 'string' && rawChecks ? checksSchema.parse(JSON.parse(rawChecks)) : null;
      if (parsedChecks && !parsedChecks.passed) return c.json({ error: '程序检查未通过的剧本不能上架，请改用 fail 并标记 needsAttention' }, 422);
      const checks: JobChecks | null = parsedChecks ? { passed: true, summary: parsedChecks.summary ?? null } : null;
      let job: TranscriptionJob | null = await store.job(workId);
      if (job?.state === 'published') {
        if (!await store.ownsLease(workId, held)) return c.json({ error: '这部剧已有剧本' }, 409);
      } else await store.assertLease(workId, held);
      const artifact = await options.scripts.put(workId, file.name, new Uint8Array(await file.arrayBuffer()), file.type);
      if (job?.state === 'published' && job.scriptId !== artifact.id) return c.json({ error: '这部剧已发布另一份剧本' }, 409);
      job = await store.publish(workId, held, artifact.id, checks);
      return c.json({ job, script: artifact }, 201);
    } catch (error) { return failure(error, c); }
  });
}

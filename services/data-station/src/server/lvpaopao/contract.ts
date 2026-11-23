/** JSON validation for requests from the 绿泡泡 Mac collector; the wire contract is documented in docs/lvpaopao.md. */
import { z } from 'zod';
import { LVPAOPAO_STATES } from '../../shared/lvpaopao.ts';

const time = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative().nullable();
const appId = z.string().regex(/^wx[0-9a-f]{16}$/);
const dramaId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const title = z.string().trim().min(1).max(160);
const reason = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
const collector = z.object({ version: z.string().min(1).max(40), host: z.string().min(1).max(120) }).strict();

const boardSchema = z.object({
  boardType: z.number().int().min(1).max(2_147_483_647), boardName: z.string().trim().min(1).max(80),
  observedAt: time, total: z.number().int().nonnegative().nullable(), pagesRead: z.number().int().nonnegative(), partial: z.boolean(),
  entries: z.array(z.object({ rank: z.number().int().positive(), title, srcAppId: appId, dramaId }).strict()).max(500),
}).strict().superRefine((board, context) => {
  const ranks = new Set<number>();
  for (const [index, entry] of board.entries.entries()) {
    if (ranks.has(entry.rank)) context.addIssue({ code: 'custom', path: ['entries', index, 'rank'], message: 'duplicate rank' });
    ranks.add(entry.rank);
  }
});

const engagementSchema = z.object({
  srcAppId: appId, dramaId, title, observedAt: time, episodeCount: z.number().int().nonnegative().nullable(), partial: z.boolean(),
  missingEpisodes: z.array(z.number().int().positive()).max(10_000),
  episodes: z.array(z.object({ episodeNo: z.number().int().positive(), likes: count, comments: count, recommendations: count, shares: count }).strict()).max(10_000),
}).strict();

/** One finished collection run; `runId` makes repeated uploads idempotent. */
export const runSchema = z.object({
  schema: z.literal(1), runId: z.string().regex(/^[A-Za-z0-9._:+-]{8,120}$/), kind: z.enum(['rankings', 'engagement']),
  slot: time, startedAt: time, finishedAt: time, status: z.enum(['complete', 'partial', 'failed']), reason: reason.nullable(),
  collector, rankings: z.array(boardSchema).max(50).default([]), engagement: z.array(engagementSchema).max(200).default([]),
}).strict().superRefine((run, context) => {
  if (run.kind === 'rankings' && run.engagement.length) context.addIssue({ code: 'custom', path: ['engagement'], message: 'rankings run carries engagement' });
  if (run.kind === 'engagement' && run.rankings.length) context.addIssue({ code: 'custom', path: ['rankings'], message: 'engagement run carries rankings' });
  if (run.status === 'complete' && run.reason !== null) context.addIssue({ code: 'custom', path: ['reason'], message: 'complete run has a reason' });
  if (run.status !== 'complete' && run.reason === null) context.addIssue({ code: 'custom', path: ['reason'], message: 'reason required' });
});
export type LvpaopaoRun = z.infer<typeof runSchema>;
export type LvpaopaoEngagement = z.infer<typeof engagementSchema>;

/** Periodic collector state report. */
export const heartbeatSchema = z.object({
  schema: z.literal(1), sentAt: time, state: z.enum(LVPAOPAO_STATES), message: z.string().max(300),
  wechat: z.object({ running: z.boolean(), loggedIn: z.boolean().nullable() }).strict(),
  lastRun: z.object({ runId: z.string().max(120), kind: z.enum(['rankings', 'engagement']), status: z.enum(['complete', 'partial', 'failed']), finishedAt: time }).strict().nullable(),
  nextSlot: time.nullable(), pendingUploads: z.number().int().nonnegative(), collector,
}).strict();
export type LvpaopaoHeartbeat = z.infer<typeof heartbeatSchema>;

export const ackSchema = z.object({ result: z.enum(['done', 'failed']), message: z.string().max(300).default('') }).strict();

/** Decoded login screenshots are capped so the base64 request stays under the 2 MiB service body limit. */
export const MAX_LOGIN_SCREEN_BYTES = 1_048_576;
export const loginScreenSchema = z.object({ capturedAt: time, kind: z.enum(['qr', 'confirm', 'unknown']), png: z.string().min(16).max(1_400_000) }).strict();

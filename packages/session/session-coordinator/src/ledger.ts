/** Validated durable task domain and revision helpers. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Assignment, CoordinationTask, CoordinationTaskId, ReportTask, RoutingTask } from './types.ts'

const status = z.enum(['dispatching', 'reconciling', 'accepted', 'running', 'finishing', 'needs-report', 'interrupted',
  'stopping', 'stopped', 'completed', 'blocked', 'needs-input', 'failed'])
const report = z.object({
  outcome: z.enum(['completed', 'blocked', 'needs-input', 'failed']), summary: z.string(),
  files: z.array(z.object({ path: z.string(), description: z.string().optional() })),
  throughSeq: z.number().int().nonnegative(),
})
const assignment = z.object({
  revision: z.number().int().positive(), key: z.string().min(1), requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  instructions: z.string().min(1),
  reason: z.string().min(1), sourceSeq: z.number().int().nonnegative(),
  reconciliation: z.object({ throughSeq: z.number().int().nonnegative(), humanSeq: z.number().int().nonnegative(),
    humanMessageId: z.string().transform(value => brandString<MessageId>(value)) }).optional(),
  messageId: z.string().transform(value => brandString<MessageId>(value)),
  briefId: z.string().transform(value => brandString<MessageId>(value)),
  forwardedIds: z.array(z.string().transform(value => brandString<MessageId>(value))),
  sessionId: z.string().transform(SessionId), createSession: z.boolean(), cwd: z.string(), sourceCwd: z.string().nullable(),
  studioProject: z.object({ owner: z.string().min(1), id: z.string().regex(/^[\w-]+$/u), title: z.string() }).optional(),
  videoKey: z.string().nullable(), status, report: report.nullable(), issue: z.string().nullable(),
  noticeId: z.string().transform(value => brandString<MessageId>(value)), notifiedStatus: status.nullable(),
  changedInputSeq: z.number().int().nonnegative().optional(), notifiedInputSeq: z.number().int().nonnegative().optional(),
  redispatch: z.object({ after: status }).optional(),
  attention: z.object({ reason: z.string().min(1), at: z.number() }).optional(),
}).superRefine((value, refinement) => {
  if (value.reconciliation === undefined && (value.forwardedIds.length === 0 || value.status === 'reconciling')) {
    refinement.addIssue({ code: 'custom', message: 'Ordinary assignments require forwarded human input' })
  }
  if (value.reconciliation !== undefined && (value.reconciliation.humanMessageId !== value.messageId
    || value.reconciliation.humanSeq > value.reconciliation.throughSeq || value.forwardedIds.length !== 0)) {
    refinement.addIssue({ code: 'custom', message: 'Reconciliation must retain its existing human input anchor without forwarding it' })
  }
})
const taskSchema: z.ZodType<CoordinationTask> = z.object({
  id: z.string().transform(value => brandString<CoordinationTaskId>(value)),
  owner: z.string().transform(SessionId), title: z.string().min(1), createdAt: z.number(),
  attempts: z.array(assignment).min(1),
})

/** Authoritative assignments; a failed or unknown write prevents dispatch. */
export const coordinationDomain = defineDomain({
  name: 'muse_coordination', version: 2, compatibleVersions: [1], layout: 'per-record',
  tables: {
    tasks: domainTable<CoordinationTaskId, CoordinationTask>(taskSchema),
    entry: domainTable<string, ReturnType<typeof SessionId>>(z.string().transform(SessionId)),
  },
})

/**
 * Select the newest revision of a validated task.
 * @param task - Task whose nonempty history passed the domain schema.
 * @returns latest assignment.
 */
export function latest(task: CoordinationTask): Assignment {
  const attempt = task.attempts.at(-1)
  if (attempt === undefined) throw new Error('Task has no assignment revisions')
  return attempt
}

/**
 * Whether a revision still reserves its worker against another goal.
 * @param attempt - Latest assignment.
 * @returns true until stopped or explicitly reported and settled.
 */
export function reservesWorker(attempt: Assignment): boolean {
  return ['dispatching', 'reconciling', 'accepted', 'running', 'finishing', 'needs-report', 'interrupted', 'stopping'].includes(attempt.status)
}

/**
 * Replace only the newest receipt while retaining all previous revisions.
 * @param task - Current task record.
 * @param changes - Receipt fields to update.
 * @returns immutable successor.
 */
export function revise(task: CoordinationTask, changes: Partial<Assignment>): CoordinationTask {
  return { ...task, attempts: [...task.attempts.slice(0, -1), { ...latest(task), ...changes }] }
}

/**
 * Project a task onto Main's routing row for its latest revision.
 * @param task - Validated task record.
 * @returns latest revision facts with presented files counted instead of listed.
 */
export function routingTask(task: CoordinationTask): RoutingTask {
  const attempt = latest(task)
  return { id: task.id, title: task.title, revision: attempt.revision, sessionId: attempt.sessionId,
    cwd: attempt.cwd, status: attempt.status, issue: attempt.issue,
    report: attempt.report === null ? null
      : { outcome: attempt.report.outcome, summary: attempt.report.summary, fileCount: attempt.report.files.length },
    ...(attempt.attention === undefined ? {} : { attention: attempt.attention }) }
}

/**
 * Project a task onto its latest-revision report row for report cards.
 * @param task - Validated task record.
 * @returns latest revision facts; report files keep only path and optional description.
 */
export function reportTask(task: CoordinationTask): ReportTask {
  const attempt = latest(task)
  return { id: task.id, title: task.title, revision: attempt.revision, sessionId: attempt.sessionId,
    cwd: attempt.cwd, status: attempt.status, issue: attempt.issue,
    report: attempt.report === null ? null : { ...attempt.report, files: attempt.report.files.map(file => ({
      path: file.path, ...(file.description === undefined ? {} : { description: file.description }),
    })) } }
}

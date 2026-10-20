/** Wire validation shared by durable waits and goal projection checkpoints. */

import { z } from 'zod'
import { JobId } from '@deepseek-ai/dsh-jobs/brand'

/** Complete persisted wait; unknown fields are rejected before replay. */
export const goalWaitSchema = z.object({
  sequence: z.number().int().nonnegative(),
  reason: z.enum(['no-tools', 'input', 'timer', 'job']),
  message: z.string().trim().min(1),
  wakeAt: z.number().int().nonnegative().optional(),
  job: z.object({
    id: z.string().min(1).transform(JobId),
    outputOffset: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict().superRefine((wait, context) => {
  if ((wait.reason === 'job') !== (wait.job !== undefined)) {
    context.addIssue({ code: 'custom', message: 'job waits require exactly one job condition' })
  }
  if (wait.reason === 'timer' && wait.wakeAt === undefined) {
    context.addIssue({ code: 'custom', message: 'timer waits require a wake time' })
  }
  if ((wait.reason === 'no-tools' || wait.reason === 'input') && wait.wakeAt !== undefined) {
    context.addIssue({ code: 'custom', message: 'input-only waits cannot have a wake time' })
  }
}).transform(wait => ({
  sequence: wait.sequence,
  reason: wait.reason,
  message: wait.message,
  ...wait.wakeAt === undefined ? {} : { wakeAt: wait.wakeAt },
  ...wait.job === undefined ? {} : { job: wait.job },
}))

/** Required, revision-fenced wait event; it never mutates the goal objective. */
export const goalWaitChangeSchema = z.object({
  kind: z.literal('goal/wait'),
  version: z.literal(1),
  ref: z.object({ id: z.string().min(1), revision: z.number().int().positive() }).strict(),
  roundsStarted: z.number().int().nonnegative(),
  wait: goalWaitSchema.nullable(),
}).strict()

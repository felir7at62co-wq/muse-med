/** Private Host records for observing a submitted batch across process restarts. */
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'

const runId = z.string().regex(/^[a-f0-9]{64}$/u)
const instant = z.number().int().nonnegative()
const positiveId = z.number().int().positive()
const outputSchema = z.object({
  subtask_id: positiveId,
  video_url: z.string().min(1),
  first_result_id: positiveId.nullable(),
  parent_result_id: positiveId.nullable(),
  resolution: z.string().nullable(),
}).strict()

const outcomeSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'unverified']),
  detail: z.string(),
  outputs: z.array(outputSchema).min(1).optional(),
}).strict().refine(value => (value.status === 'succeeded') === (value.outputs !== undefined),
  'Only a verified successful operation has output records')

const packSchema = z.object({
  previewPath: z.string().refine(value => isAbsolute(value)),
  key: runId,
  storyboardId: positiveId.optional(),
  taskId: positiveId.optional(),
  outcome: outcomeSchema.optional(),
}).strict().refine(value => value.outcome?.status !== 'succeeded' || value.taskId !== undefined,
  'A successful operation requires its provider task identity')

const noticeSchema = z.object({ id: z.uuid(), text: z.string().min(1), deliveredAt: instant.optional() }).strict()

/** Room assignment captured by Muse Bot before submitting generation. */
export const generationWatchGroupOrigin = z.object({
  roomId: z.string().min(1),
  workerBotId: z.string().min(1),
  requesterBotId: z.string().min(1),
  requesterSessionId: z.string().min(1),
  exchangeId: z.string().min(1),
}).strict().refine(origin => origin.workerBotId !== origin.requesterBotId, 'A room assignment requires two members')

const runSchema = z.object({
  id: runId,
  sessionId: z.string().min(1).transform(SessionId),
  groupOrigin: generationWatchGroupOrigin.optional(),
  createdAt: instant,
  deadlineAt: instant,
  nextPollAt: instant.optional(),
  packs: z.array(packSchema).min(1),
  notice: noticeSchema.optional(),
  recoveryNotice: noticeSchema.optional(),
  recoveryExhausted: z.literal(true).optional(),
  reviewRequired: z.literal(true).optional(),
}).strict().refine(value => value.deadlineAt >= value.createdAt, 'The deadline precedes the run')
  .refine(value => new Set(value.packs.map(pack => pack.key)).size === value.packs.length,
    'The run contains duplicate preview keys')
  .refine(value => value.notice === undefined || value.packs.every(pack => pack.outcome !== undefined),
    'A terminal notice requires a recorded outcome for every pack')
  .refine(value => value.recoveryNotice === undefined || (value.notice !== undefined && value.recoveryNotice.id !== value.notice.id),
    'Recovery requires an original notice and a distinct message identity')

/** Media evidence returned by the verified provider operation. */
export type GenerationWatchOutput = z.infer<typeof outputSchema>
/** One terminal observation, independent of episode quality or delivery. */
export type GenerationWatchOutcome = z.infer<typeof outcomeSchema>
/** One frozen preview identity and its provider observation. */
export type GenerationWatchPack = z.infer<typeof packSchema>
/** Stable outbox entry whose receipt acknowledges only the Session inbox. */
export type GenerationWatchNotice = z.infer<typeof noticeSchema>
/** The original group assignment, validated again by its owner at continuation. */
export type GenerationWatchGroupOrigin = z.infer<typeof generationWatchGroupOrigin>
/** Host-owned run and checkpoint for the original submitting Session. */
export type GenerationWatchRun = z.infer<typeof runSchema>

function sameInputs(previous: GenerationWatchRun, next: GenerationWatchRun): boolean {
  return previous.sessionId === next.sessionId && previous.packs.length === next.packs.length
    && previous.packs.every(pack => next.packs.some(candidate => candidate.key === pack.key
      && candidate.previewPath === pack.previewPath))
}

/** Atomic local checkpoints. The owning Host serializes worker updates for each run. */
export class GenerationWatchStore {
  /** @param root - Host-private directory for generation watch records. */
  constructor(private readonly root: string) {}

  /**
   * Load a checkpoint without changing its state.
   * @param id - SHA-256 run identifier.
   * @returns The validated checkpoint, or undefined when the file is absent.
   */
  async load(id: string): Promise<GenerationWatchRun | undefined> {
    const path = this.path(id)
    try {
      const run = runSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      if (run.id !== id) throw new Error('Generation watch checkpoint has a different run identifier')
      return run
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /**
   * Load runs whose terminal notice has not been durably delivered.
   * @param onUnreadable - Report one invalid run while continuing to load unrelated runs.
   * @returns Existing active checkpoints, including pending outbox entries.
   */
  async listActive(onUnreadable?: (id: string, error: unknown) => void): Promise<GenerationWatchRun[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true })
      const runs = await Promise.all(entries.filter(entry => /^[a-f0-9]{64}\.json$/u.test(entry.name))
        .map(async (entry) => {
          const id = entry.name.slice(0, -5)
          try {
            if (!entry.isFile()) throw new Error('Generation watch checkpoint must be a regular file')
            return await this.load(id)
          } catch (error) {
            if (onUnreadable === undefined) throw error
            onUnreadable(id, error)
            return undefined
          }
        }))
      return runs.filter((run): run is GenerationWatchRun => run !== undefined && run.notice?.deliveredAt === undefined)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /**
   * Register the original inputs once. Replays keep their existing deadlines and results.
   * @param run - Initial checkpoint for the exact batch submitted by the owning Session.
   * @returns The existing or newly saved checkpoint.
   */
  async create(run: GenerationWatchRun): Promise<GenerationWatchRun> {
    const candidate = runSchema.parse(run)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const path = this.path(candidate.id)
    return await withFileLock(path, async () => {
      const prior = await this.load(candidate.id)
      if (prior === undefined) {
        await this.write(path, candidate)
        return candidate
      }
      if (!sameInputs(prior, candidate)) throw new Error('Generation watch run inputs changed')
      return prior
    })
  }

  /**
   * Replace a run checkpoint after a Host-owned state transition.
   * @param run - Complete next value; frozen inputs and a published notice keep their identity.
   */
  async put(run: GenerationWatchRun): Promise<void> {
    const candidate = runSchema.parse(run)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const path = this.path(candidate.id)
    await withFileLock(path, async () => {
      const prior = await this.load(candidate.id)
      if (prior !== undefined) {
        if (!sameInputs(prior, candidate) || prior.createdAt !== candidate.createdAt || prior.deadlineAt !== candidate.deadlineAt) {
          throw new Error('Generation watch run inputs or deadline changed')
        }
        if (JSON.stringify(prior.groupOrigin) !== JSON.stringify(candidate.groupOrigin)) {
          throw new Error('Generation watch group assignment changed')
        }
        if (prior.notice !== undefined && (candidate.notice?.id !== prior.notice.id
          || candidate.notice.text !== prior.notice.text
          || (prior.notice.deliveredAt !== undefined && candidate.notice.deliveredAt !== prior.notice.deliveredAt))) {
          throw new Error('Generation watch notice identity or delivery receipt changed')
        }
        if (prior.recoveryNotice !== undefined && (candidate.recoveryNotice?.id !== prior.recoveryNotice.id
          || candidate.recoveryNotice.text !== prior.recoveryNotice.text)) throw new Error('Generation recovery identity changed')
      }
      await this.write(path, candidate)
    })
  }

  private path(id: string): string { return join(this.root, `${runId.parse(id)}.json`) }

  private async write(path: string, run: GenerationWatchRun): Promise<void> {
    await writeFileAtomic(path, `${JSON.stringify(run)}\n`, { mode: 0o600, dirMode: 0o700 })
  }
}

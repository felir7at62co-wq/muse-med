/** Private Host records for observing a submitted batch across process restarts. */
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { generationSessionBindingSchema } from './generation-binding.ts'

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
  binding: generationSessionBindingSchema.optional(),
  createdAt: instant,
  deadlineAt: instant,
  nextPollAt: instant.optional(),
  packs: z.array(packSchema).min(1),
  notice: noticeSchema.optional(),
  recoveryNotice: noticeSchema.optional(),
  recoveryExhausted: z.literal(true).optional(),
  reviewRequired: z.literal(true).optional(),
}).strict().refine(value => value.deadlineAt >= value.createdAt, 'The deadline precedes the run')
  .refine(value => value.binding === undefined || value.binding.sessionId === value.sessionId, 'Binding belongs to another Session')
  .refine(value => new Set(value.packs.map(pack => pack.key)).size === value.packs.length,
    'The run contains duplicate preview keys')
  .refine(value => value.notice === undefined || value.packs.every(pack => pack.outcome !== undefined),
    'A terminal notice requires a recorded outcome for every pack')
  .refine(value => value.recoveryNotice === undefined || (value.notice !== undefined && value.recoveryNotice.id !== value.notice.id),
    'Recovery requires an original notice and a distinct message identity')

const ownerSchema = z.object({ runId, sessionId: z.string().min(1), previewPath: z.string().refine(isAbsolute) }).strict()
const ownershipSchema = z.object({ version: z.literal(1), keys: z.record(runId, ownerSchema) }).strict()
const indexedRunSchema = z.object({
  sessionId: z.string().min(1),
  packs: z.array(z.object({ key: runId, previewPath: z.string().refine(isAbsolute) }).strict()).min(1),
  binding: generationSessionBindingSchema.optional(),
  startedKeys: z.array(runId),
  noSend: z.boolean(),
  dispatchFinished: z.boolean(),
  successor: runId.optional(),
}).strict()
const ownershipV2Schema = z.object({ version: z.literal(2), keys: z.record(runId, ownerSchema),
  runs: z.record(runId, indexedRunSchema) }).strict()
type OwnershipIndex = z.infer<typeof ownershipV2Schema>

function indexedRun(run: GenerationWatchRun, dispatchFinished = false): z.infer<typeof indexedRunSchema> {
  return { sessionId: run.sessionId, packs: run.packs.map(({ key, previewPath }) => ({ key, previewPath })),
    ...(run.binding === undefined ? {} : { binding: run.binding }),
    startedKeys: [], noSend: false, dispatchFinished }
}

function sameIndexedInputs(indexed: z.infer<typeof indexedRunSchema>, run: GenerationWatchRun): boolean {
  return indexed.sessionId === run.sessionId && indexed.packs.length === run.packs.length
    && JSON.stringify(indexed.binding) === JSON.stringify(run.binding)
    && indexed.packs.every(pack => run.packs.some(item => item.key === pack.key && item.previewPath === pack.previewPath))
}

/** Conflicting historical identities cannot be assigned to an automatic continuation. */
export class GenerationWatchOwnershipConflict extends Error {
  constructor() { super('Generation watch ownership is ambiguous; retain the original records for review') }
}

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
    && JSON.stringify(previous.binding) === JSON.stringify(next.binding)
    && previous.packs.every(pack => next.packs.some(candidate => candidate.key === pack.key
      && candidate.previewPath === pack.previewPath))
}

/** Original submitting identity returned only after Host attestation. */
export interface GenerationWatchVerifiedOwner {
  runId: string
  sessionId: SessionId
  key: string
  previewPath: string
}

/**
 * Host-owned verifier of durable submission events, ledger and project identity.
 * Implementations must reject missing or ambiguous evidence and must not infer
 * the submitting Session from a user-writable manifest.
 */
export type GenerationWatchOwnerAttestor = (owner: Readonly<GenerationWatchVerifiedOwner>, projectDir: string) => Promise<boolean>

/** Atomic local checkpoints. The owning Host serializes worker updates for each run. */
export class GenerationWatchStore {
  private readonly reservedHere = new Set<string>()
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
    return (await this.listAll(onUnreadable)).filter(run => run.notice?.deliveredAt === undefined && run.reviewRequired !== true)
  }

  /**
   * Read all original checkpoints, including completed ones, without inventing missing ownership.
   * @param onUnreadable - Optional report for an unreadable checkpoint; omission fails closed.
   * @returns Validated checkpoints in the Host-private directory.
   */
  async listAll(onUnreadable?: (id: string, error: unknown) => void): Promise<GenerationWatchRun[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true })
      const runs = await Promise.all(entries.filter(entry => /^[a-f0-9]{64}\.json$/u.test(entry.name))
        .map(async (entry) => {
          const id = entry.name.slice(0, -5)
          try {
            if (!entry.isFile()) throw new Error('Generation watch checkpoint must be a regular file')
            const run = await this.load(id)
            if (run === undefined) throw new Error('Generation watch checkpoint disappeared during enumeration')
            return run
          } catch (error) {
            if (onUnreadable === undefined) throw error
            onUnreadable(id, error)
            return undefined
          }
        }))
      return runs.filter((run): run is GenerationWatchRun => run !== undefined)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /**
   * Bind every original key to one checkpoint and Session across local Host processes.
   * Historical checkpoints are scanned while the ownership index is locked; ambiguous
   * or unreadable history refuses the claim rather than choosing an owner. Existing
   * checkpoints and Session logs are not rewritten by this index.
   * @param run - Original checkpoint and its immutable preview identities.
   * @param signal - Host lifetime cancellation while waiting for the lock.
   */
  async claimOwnership(run: GenerationWatchRun, signal?: AbortSignal): Promise<void> {
    await this.assignOwnership(run, false, signal)
    if (await this.load(run.id) === undefined) this.reservedHere.add(run.id)
  }

  /**
   * Claim the original keys and create the first checkpoint while holding the same writer lock.
   * A concurrent caller with identical inputs is not a new dispatch owner.
   * @param run - Initial checkpoint for the original Session and keys.
   * @param signal - Host lifetime cancellation while waiting for the lock.
   * @returns Whether this call created the checkpoint.
   */
  async claimAndCreate(run: GenerationWatchRun, signal?: AbortSignal): Promise<boolean> {
    return await this.assignOwnership(run, true, signal)
  }

  private async readIndex(): Promise<OwnershipIndex> {
    let index: OwnershipIndex
    try { index = ownershipV2Schema.parse(JSON.parse(await readFile(join(this.root, 'ownership.v2.json'), 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      let legacy: z.infer<typeof ownershipSchema>
      try { legacy = ownershipSchema.parse(JSON.parse(await readFile(join(this.root, 'ownership.v1.json'), 'utf8'))) }
      catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') throw legacyError
        legacy = { version: 1, keys: {} }
      }
      index = { version: 2, keys: legacy.keys, runs: {} }
    }
    const unreadable: string[] = []
    const history = await this.listAll((id) => { unreadable.push(id) })
    for (const id of unreadable) {
      if (index.runs[id] === undefined) throw new GenerationWatchOwnershipConflict()
    }
    for (const run of history) {
      const known = index.runs[run.id]
      if (known !== undefined) {
        if (!sameIndexedInputs(known, run)) throw new GenerationWatchOwnershipConflict()
        continue
      }
      for (const pack of run.packs) {
        const owner = index.keys[pack.key]
        if (owner !== undefined && (owner.runId !== run.id || owner.sessionId !== run.sessionId
          || owner.previewPath !== pack.previewPath)) throw new GenerationWatchOwnershipConflict()
        index.keys[pack.key] = { runId: run.id, sessionId: run.sessionId, previewPath: pack.previewPath }
      }
      index.runs[run.id] = indexedRun(run, true)
    }
    // A v1 key without its readable original record cannot be migrated by inference.
    for (const owner of Object.values(index.keys)) {
      if (index.runs[owner.runId] === undefined) throw new GenerationWatchOwnershipConflict()
    }
    this.validateIndex(index)
    return index
  }

  private validateIndex(index: OwnershipIndex): void {
    for (const [id, entry] of Object.entries(index.runs)) {
      const keys = entry.packs.map(pack => pack.key)
      if (new Set(keys).size !== keys.length || new Set(entry.startedKeys).size !== entry.startedKeys.length
        || entry.startedKeys.some(key => !keys.includes(key)) || (entry.noSend && entry.startedKeys.length !== 0)) {
        throw new GenerationWatchOwnershipConflict()
      }
      let targetId = id, target = entry
      const visited = new Set<string>()
      while (target.successor !== undefined) {
        if (!target.noSend || visited.has(targetId)) throw new GenerationWatchOwnershipConflict()
        visited.add(targetId)
        targetId = target.successor
        const successor = index.runs[targetId]
        if (successor === undefined || successor.sessionId !== entry.sessionId
          || JSON.stringify(successor.binding) !== JSON.stringify(entry.binding)
          || successor.packs.length !== entry.packs.length
          || !successor.packs.every(pack => entry.packs.some(prior => prior.key === pack.key && prior.previewPath === pack.previewPath))) {
          throw new GenerationWatchOwnershipConflict()
        }
        target = successor
      }
      if (entry.packs.some((pack) => {
        const owner = index.keys[pack.key]
        return owner?.runId !== targetId || owner.sessionId !== entry.sessionId || owner.previewPath !== pack.previewPath
      })) throw new GenerationWatchOwnershipConflict()
    }
    for (const [key, owner] of Object.entries(index.keys)) {
      const entry = index.runs[owner.runId]
      if (entry === undefined || entry.sessionId !== owner.sessionId
        || !entry.packs.some(pack => pack.key === key && pack.previewPath === owner.previewPath)) {
        throw new GenerationWatchOwnershipConflict()
      }
    }
  }

  private async saveIndex(index: OwnershipIndex): Promise<void> {
    this.validateIndex(index)
    await writeFileAtomic(join(this.root, 'ownership.v2.json'), `${JSON.stringify(index)}\n`, { mode: 0o600, dirMode: 0o700 })
    await writeFileAtomic(join(this.root, 'ownership.v1.json'), `${JSON.stringify({ version: 1, keys: index.keys })}\n`,
      { mode: 0o600, dirMode: 0o700 })
  }

  private async assignOwnership(run: GenerationWatchRun, create: boolean, signal?: AbortSignal,
    predecessor?: string, allowReserved = false): Promise<boolean> {
    const candidate = runSchema.parse(run)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    return await withFileLock(join(this.root, 'ownership.v1.json'), async () => {
      const index = await this.readIndex()
      const known = index.runs[candidate.id]
      if (known !== undefined && !sameIndexedInputs(known, candidate)) throw new Error('Generation watch run inputs changed')
      const previous = predecessor === undefined ? undefined : index.runs[predecessor]
      if (predecessor !== undefined && (previous === undefined || !previous.noSend || previous.startedKeys.length !== 0
        || !sameIndexedInputs(previous, candidate) || (previous.successor !== undefined && previous.successor !== candidate.id))) {
        throw new GenerationWatchOwnershipConflict()
      }
      for (const pack of candidate.packs) {
        const prior = index.keys[pack.key]
        if (prior !== undefined && (prior.runId !== candidate.id || prior.sessionId !== candidate.sessionId
          || prior.previewPath !== pack.previewPath)
          && !(predecessor !== undefined && prior.runId === predecessor
            && prior.sessionId === candidate.sessionId && prior.previewPath === pack.previewPath)) {
          throw new GenerationWatchOwnershipConflict()
        }
      }
      const existing = await this.load(candidate.id)
      if (create && known !== undefined && existing === undefined && !allowReserved) {
        // An interrupted index/checkpoint publication is not a new dispatch permission.
        throw new GenerationWatchOwnershipConflict()
      }
      if (previous !== undefined) previous.successor = candidate.id
      index.runs[candidate.id] ??= indexedRun(candidate)
      for (const pack of candidate.packs) {
        index.keys[pack.key] = { runId: candidate.id, sessionId: candidate.sessionId, previewPath: pack.previewPath }
      }
      signal?.throwIfAborted()
      await this.saveIndex(index)
      if (!create || existing !== undefined) return false
      await this.createCheckpoint(candidate)
      return true
    }, signal === undefined ? undefined : { signal })
  }

  /**
   * Record a transport fence before one enrolled key can issue its paid request.
   * @param id - Active run whose normal submission owns the key.
   * @param key - Exact enrolled key about to be sent.
   */
  async markDispatchStarted(id: string, key: string): Promise<void> {
    await this.updateDispatch(id, (entry) => {
      if (entry.noSend || entry.successor !== undefined || !entry.packs.some(pack => pack.key === key)) {
        throw new GenerationWatchOwnershipConflict()
      }
      if (!entry.startedKeys.includes(key)) entry.startedKeys.push(key)
    })
  }

  /**
   * Record the owning invocation's completed preflight without any transport fence.
   * @param id - Run whose trusted dispatch wrapper finished before any paid send.
   */
  async recordNoSend(id: string): Promise<void> {
    await this.updateDispatch(id, (entry) => {
      if (entry.startedKeys.length !== 0 || entry.successor !== undefined) throw new GenerationWatchOwnershipConflict()
      entry.noSend = true
    })
  }

  private async updateDispatch(id: string, update: (entry: z.infer<typeof indexedRunSchema>) => void): Promise<void> {
    await withFileLock(join(this.root, 'ownership.v1.json'), async () => {
      const index = await this.readIndex()
      const entry = index.runs[runId.parse(id)]
      if (entry === undefined || entry.packs.some(pack => index.keys[pack.key]?.runId !== id)) {
        throw new GenerationWatchOwnershipConflict()
      }
      update(entry)
      await this.saveIndex(index)
    })
  }

  /**
   * Seal the normal submission invocation before background observation can finish it.
   * @param id - Original run whose dispatch wrapper has returned.
   */
  async finishInitialDispatch(id: string): Promise<void> {
    await this.updateDispatch(id, (entry) => { entry.dispatchFinished = true })
  }

  /**
   * Check whether background observation may advance a checkpoint.
   * @param id - Run currently held under its recovery lease.
   * @returns True for completed initial work or a fenced request needing read-only crash recovery.
   */
  async mayObserve(id: string): Promise<boolean> {
    return await withFileLock(join(this.root, 'ownership.v1.json'), async () => {
      const index = await this.readIndex(), entry = index.runs[runId.parse(id)]
      return entry !== undefined && entry.successor === undefined && (entry.dispatchFinished || entry.startedKeys.length > 0)
    })
  }

  /**
   * Check whether an unsent invocation was replaced by its explicit correction.
   * @param id - Prior run whose stored receipt remains unchanged.
   * @returns Whether a successor now owns its original keys.
   */
  async isRetired(id: string): Promise<boolean> {
    return await withFileLock(join(this.root, 'ownership.v1.json'), async () => {
      const index = await this.readIndex()
      return index.runs[runId.parse(id)]?.successor !== undefined
    })
  }

  /**
   * Test for a completed transport-free invocation recorded by this Host protocol.
   * @param id - Original run to examine.
   * @returns Whether the original keys can be assigned to a corrected invocation.
   */
  async hasNoSend(id: string): Promise<boolean> {
    return await withFileLock(join(this.root, 'ownership.v1.json'), async () => {
      const index = await this.readIndex(), entry = index.runs[runId.parse(id)]
      return entry?.noSend === true && entry.startedKeys.length === 0
    })
  }

  /**
   * Atomically transfer an explicitly unsent run to a corrected invocation.
   * @param originalId - Original run retaining its failed-preflight receipt.
   * @param run - New run with the same Session, keys and previews.
   * @param signal - Host cancellation while waiting for the ownership writer.
   * @returns Whether the new checkpoint was created by this caller.
   */
  async retryUnsent(originalId: string, run: GenerationWatchRun, signal?: AbortSignal): Promise<boolean> {
    return await this.assignOwnership(run, true, signal, originalId)
  }

  /**
   * Look up a unique original Session after the Host verifies its durable evidence.
   * The attestor reads outside the index lock; a second lookup rejects changed
   * ownership or review state. The result identifies a submitter, not a reviewer.
   * @param key - Original generation idempotency key.
   * @param previewPath - Absolute original preview path.
   * @param projectDir - Absolute project directory to attest against the ledger.
   * @param attest - Host-owned verifier for Session events, ledger and project.
   * @returns The original submitting identity, or undefined if evidence is unavailable.
   */
  async resolveVerifiedOwner(key: string, previewPath: string, projectDir: string,
    attest: GenerationWatchOwnerAttestor): Promise<GenerationWatchVerifiedOwner | undefined> {
    runId.parse(key)
    if (!isAbsolute(previewPath) || !isAbsolute(projectDir)) throw new Error('Expected absolute project and preview paths')
    if (typeof attest !== 'function') throw new Error('A Host ownership attestor is required')
    const snapshot = async (): Promise<GenerationWatchVerifiedOwner | undefined> => {
      const path = join(this.root, 'ownership.v1.json')
      return await withFileLock(path, async () => {
        const index = await this.readIndex()
        const owner = index.keys[key]
        if (owner === undefined || owner.previewPath !== previewPath) return undefined
        const run = await this.load(owner.runId)
        if (run === undefined || run.sessionId !== owner.sessionId || run.groupOrigin !== undefined || run.reviewRequired === true
          || !run.packs.some(pack => pack.key === key && pack.previewPath === previewPath)) return undefined
        return { runId: run.id, sessionId: run.sessionId, key, previewPath }
      })
    }
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const before = await snapshot()
      if (before === undefined || !await attest(Object.freeze({ ...before }), projectDir)) return undefined
      const after = await snapshot()
      return after !== undefined && JSON.stringify(before) === JSON.stringify(after) ? after : undefined
    } catch (error) {
      if (error instanceof GenerationWatchOwnershipConflict) return undefined
      throw error
    }
  }

  /**
   * Serialize recovery of one checkpoint across Host processes on this machine.
   * @param id - Original watch checkpoint identifier.
   * @param signal - Host lifetime cancellation while waiting for the lock.
   * @param waitMs - Contention budget for the caller's bounded operation.
   * @param operation - Work that re-reads the checkpoint after acquiring the lock.
   * @returns The operation result after releasing its lease.
   */
  async withRecoveryLease<T>(id: string, signal: AbortSignal, waitMs: number, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    return await withFileLock(join(this.root, `${runId.parse(id)}.recovery`), operation, { signal, waitMs })
  }

  /**
   * Register the original inputs once. Replays keep their existing deadlines and results.
   * @param run - Initial checkpoint for the exact batch submitted by the owning Session.
   * @returns The existing or newly saved checkpoint.
   */
  async create(run: GenerationWatchRun): Promise<GenerationWatchRun> {
    await this.assignOwnership(run, true, undefined, undefined, this.reservedHere.has(run.id))
    this.reservedHere.delete(run.id)
    await this.finishInitialDispatch(run.id)
    const created = await this.load(run.id)
    if (created === undefined) throw new GenerationWatchOwnershipConflict()
    return created
  }

  private async createCheckpoint(run: GenerationWatchRun): Promise<GenerationWatchRun> {
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
    await withFileLock(join(this.root, 'ownership.v1.json'), async () => {
      const index = await this.readIndex()
      const indexed = index.runs[candidate.id]
      if (indexed === undefined || !sameIndexedInputs(indexed, candidate)) {
        throw new GenerationWatchOwnershipConflict()
      }
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
    })
  }

  private path(id: string): string { return join(this.root, `${runId.parse(id)}.json`) }

  private async write(path: string, run: GenerationWatchRun): Promise<void> {
    await writeFileAtomic(path, `${JSON.stringify(run)}\n`, { mode: 0o600, dirMode: 0o700 })
  }
}

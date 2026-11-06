/** Short durable episode admission and instance-owned approved-source rendering. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, readdir, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { type Context } from '@deepseek-ai/cordis'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { assertApprovedEpisodePlan, readApprovedEpisodePlan, episodePlanDigest, type ApprovedEpisodePlan } from './approved-episode-plan.ts'
import { attemptIdentitySchema, createEpisodeDeliveryJob, parseEpisodeDeliveryJobRecord, episodeHashSchema, executionDrainSchema,
  hashEpisodeFile, assertEpisodeFileVersion, readEpisodeRecord, runningExecutionSchema } from './episode-delivery.ts'
import type { ApprovedEpisodeRendererCapture, ApprovedEpisodeCandidate, AttemptIdentity, EpisodeAttemptId,
  EpisodeCancellationReason, EpisodeExecutionId, EpisodeFileVersion, EpisodeRenderResult, Sha256 } from './episode-delivery.ts'
import { ApprovedSourceCancellationError } from './video-recovery-service.ts'
import type { ApprovedVideoSource, ApprovedVideoSourceAdmission, EpisodeReadinessInput, EpisodeAdmissionInput, EpisodeStatusInput,
  EpisodeReadiness, EpisodeDeliveryStatus, VideoRecoveryDigest, VideoRecoveryIntentDigest } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Approved-source full-episode delivery, independent of direct clip delivery. */
    jubianEpisodeDelivery: JubianEpisodeDelivery
  }
}

/** Validated deployment limits; large media work never holds an admission or source writer queue. */
export interface JubianEpisodeDeliveryOptions {
  readonly metadataMaxBytes: number
  readonly recordBytes: number
  readonly lockWaitMs: number
}

/** Optional episode delivery deployment limits; Settings mode mounts the service. */
export interface EpisodeDeliveryConfig {
  /** Bytes per editing JSON/SRT/policy snapshot; default 1048576, integer 1..16777216. */
  episodeDeliveryMetadataMaxBytes?: number
  /** Bytes per durable episode journal record; default 1048576, integer 1..16777216. */
  episodeDeliveryRecordBytes?: number
  /** Cross-process admission lock wait in milliseconds; default 30000, integer 1..60000. */
  episodeDeliveryLockWaitMs?: number
}

/**
 * Resolve deployment defaults before mounting any episode service effects.
 * @param config - Explicit optional limits from cordis.yml.
 * @returns Validated complete metadata, record and lock limits.
 */
export function resolveEpisodeDelivery(config: EpisodeDeliveryConfig): JubianEpisodeDeliveryOptions {
  const metadataMaxBytes = config.episodeDeliveryMetadataMaxBytes ?? 1048576
  const recordBytes = config.episodeDeliveryRecordBytes ?? 1048576
  const lockWaitMs = config.episodeDeliveryLockWaitMs ?? 30000
  if (!Number.isSafeInteger(metadataMaxBytes) || metadataMaxBytes < 1 || metadataMaxBytes > 16777216
    || !Number.isSafeInteger(recordBytes) || recordBytes < 1 || recordBytes > 16777216
    || !Number.isSafeInteger(lockWaitMs) || lockWaitMs < 1 || lockWaitMs > 60000) {
    throw new Error('Episode delivery requires bounded positive metadata, record and lock limits')
  }
  return { metadataMaxBytes, recordBytes, lockWaitMs }
}

const targetSchema = z.strictObject({ projectDir: z.string().min(1), episode: z.number().int().min(1).max(99) })
const statusInputSchema = targetSchema.extend({ digest: episodeHashSchema })
const admissionSchema = statusInputSchema.extend({ resume: z.literal(true).optional() })
const sourceSchema = z.strictObject({ idempotencyKey: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/u).transform(value => brandString<VideoRecoveryDigest>(value)),
  intentDigest: z.string().regex(/^[a-f0-9]{64}$/u).transform(value => brandString<VideoRecoveryIntentDigest>(value)),
  taskId: z.number().int().positive(),
  kind: z.enum(['provider', 'derivative']), path: z.string().min(1), sha256: episodeHashSchema })
const runtimeSchema = z.strictObject({ path: z.string().min(1), sha256: episodeHashSchema,
  bytes: z.number().int().nonnegative(), owner: z.enum(['renderer', 'media', 'font']) })
const planInputSchema = z.strictObject({ role: z.enum(['project', 'plan', 'timeline', 'subtitle', 'mix-profile', 'bgm']),
  path: z.string().min(1), sha256: episodeHashSchema, bytes: z.number().int().nonnegative() })
const intentSchema = z.strictObject({ version: z.literal(1), kind: z.literal('approved-episode-intent'),
  projectDir: z.string().min(1), episode: z.number().int().min(1).max(99), digest: episodeHashSchema,
  identity: attemptIdentitySchema, planDigest: episodeHashSchema, codeSha256: episodeHashSchema,
  runtimeInputs: z.array(runtimeSchema), planInputs: z.array(planInputSchema).min(5), sources: z.array(sourceSchema).min(1) })
/** Version-one immutable original claim; random generations never enter its logical digest. */
export type EpisodeDeliveryIntentRecord = z.infer<typeof intentSchema>
type Intent = EpisodeDeliveryIntentRecord
const outputSchema = z.strictObject({ path: z.string().min(1), sha256: episodeHashSchema, bytes: z.number().int().positive() })
const stateSchema = z.strictObject({ version: z.literal(1), attempt: z.uuid(), digest: episodeHashSchema,
  state: z.enum(['queued', 'preparing', 'running', 'stopping', 'completed', 'cancelled', 'failed', 'unknown']),
  execution: z.uuid().optional(), cancellationReason: z.enum(['configuration-changed', 'provider-disposed', 'explicit-stop', 'host-disconnected']).optional(),
  output: outputSchema.optional(), problem: z.string().optional() })
/** Version-one targeted observations; this state is not authority to bypass execution journals. */
export type EpisodeDeliveryStateRecord = z.infer<typeof stateSchema>
type StoredState = EpisodeDeliveryStateRecord
const cancellationSchema = z.strictObject({ version: z.literal(1), attempt: z.uuid(), execution: z.uuid(),
  dispatched: z.boolean(),
  reason: z.enum(['configuration-changed', 'provider-disposed', 'explicit-stop', 'host-disconnected']) })
/** Version-one cancellation intent, committed before the consumer is aborted. */
export type EpisodeDeliveryCancellationRecord = z.infer<typeof cancellationSchema>
const receiptSchema = z.strictObject({ version: z.literal(1), kind: z.literal('approved-episode-delivery'),
  identity: attemptIdentitySchema, execution: z.uuid(), output: outputSchema,
  width: z.number().int().positive(), height: z.number().int().positive(), durationUs: z.number().int().positive(),
  video: z.literal(true), audio: z.literal(true) })
/** Version-one measured full-episode publication, separate from direct clip receipts. */
export type EpisodeDeliveryReceiptRecord = z.infer<typeof receiptSchema>

interface Prepared {
  readonly plan: ApprovedEpisodePlan
  readonly capture: ApprovedEpisodeRendererCapture
  readonly sources: readonly ApprovedVideoSource[]
  readonly admission: ApprovedVideoSourceAdmission
  readonly digest: Sha256
}
interface Work {
  readonly done: Promise<void>
  pending: boolean
}

function hash(value: object): Sha256 {
  return brandString<Sha256>(createHash('sha256').update(JSON.stringify(value)).digest('hex'))
}
function sourceFacts(sources: readonly ApprovedVideoSource[]): Intent['sources'] {
  return sources.map(source => ({ idempotencyKey: source.idempotencyKey, digest: source.digest,
    intentDigest: source.intentDigest, taskId: source.taskId, kind: source.source.kind,
    path: source.source.path, sha256: source.source.sha256 }))
}
function attemptId(input: EpisodeStatusInput): EpisodeAttemptId {
  const hex = createHash('sha256').update(JSON.stringify([input.projectDir, input.episode, input.digest])).digest('hex')
  return brandString<EpisodeAttemptId>(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`)
}
function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
function occupied(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('Episode directory must be canonical and regular')
}
async function canonical(projectDir: string): Promise<string> {
  if (!isAbsolute(projectDir)) throw new Error('Episode project must be absolute')
  const path = await realpath(projectDir)
  if (!(await lstat(path)).isDirectory()) throw new Error('Episode project must be a directory')
  return path
}
function same(left: object, right: object): boolean { return JSON.stringify(left) === JSON.stringify(right) }

/** Service-owned long work; only the exact immutable logical claim is committed by admission RPC. */
export class JubianEpisodeDelivery extends TypertRemoteService {
  static inject = ['jubianVideoRecovery']
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly prepared = new Map<number, Prepared>()
  private readonly work = new Map<EpisodeAttemptId, Work>()
  private readonly unknown = new Set<EpisodeAttemptId>()
  private tail: Promise<void> = Promise.resolve()
  private queue: Promise<void> = Promise.resolve()
  private activeOperations = 0
  private closing = false
  private paused = false

  /**
   * @param ctx - Actual recovery and renderer providers.
   * @param options - Validated metadata and journal limits.
   */
  constructor(ctx: Context, private readonly options: JubianEpisodeDeliveryOptions) {
    super(ctx, 'jubianEpisodeDelivery')
    for (const limit of Object.values(options)) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Episode delivery limits must be positive safe integers')
    }
    ctx.effect(() => async () => {
      this.closing = true; this.paused = true
      this.lifetime.abort(new Error('Episode delivery provider disposed'))
      const admitted = [...this.work.values()].map(work => work.done)
      const results = await Promise.allSettled([...this.operations, ...admitted, this.tail, this.queue])
      this.prepared.clear()
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })
  }

  /** Stop accepting new work without cancelling or awaiting an active encoder. */
  pauseAdmission(): void { this.paused = true }
  /** Resume new admission after an update inspection releases its pause. */
  resumeAdmission(): void { if (!this.closing) this.paused = false }
  /**
   * Inspect this instance's owned work and observed unresolved executions without waiting.
   * @returns Whether preparation, queued/running work or an observed unknown fence remains.
   */
  hasActiveWork(): boolean {
    return this.activeOperations > 0 || this.unknown.size > 0 || [...this.work.values()].some(work => work.pending)
  }

  /**
   * Measure current editing inputs, original approvals and the actual renderer without admitting work.
   * @param input - Explicit project and episode.
   * @returns A selection digest excluding random provider generation, or actionable readiness errors.
   */
  @Remote
  episodeReadiness(input: EpisodeReadinessInput): Promise<EpisodeReadiness> {
    const target = targetSchema.parse(input), caller = this.ctx.invocation?.signal
    return this.owned(async (signal) => {
      const projectDir = await canonical(target.projectDir)
      try {
        if (this.paused) throw new Error('Episode admission is paused')
        const plan = await readApprovedEpisodePlan(projectDir, target.episode, this.options.metadataMaxBytes, signal)
        const renderer = this.ctx.get('approvedEpisodeRenderer')
        if (renderer === undefined) throw new Error('Episode renderer is unavailable')
        const capture = await renderer.capture(plan, signal)
        capture.signal.throwIfAborted()
        const prepared = await this.ctx.jubianVideoRecovery.withApprovedSources({ items: plan.shots.map(shot => shot.input),
          metadataMaxBytes: this.options.metadataMaxBytes }, signal, async (lease) => {
          if (lease.sources.some(source => source.project.directory !== projectDir)) {
            throw new Error('Episode sources belong to another selected project')
          }
          await assertApprovedEpisodePlan(plan, lease.signal)
          const digest = hash({ planDigest: plan.digest, sources: sourceFacts(lease.sources),
            renderer: { configurationSha256: capture.identity.configurationSha256, codeSha256: capture.identity.codeSha256,
              runtimeInputs: capture.runtimeInputs } })
          return { plan, capture, sources: lease.sources, admission: lease.admission, digest }
        })
        capture.signal.throwIfAborted()
        this.prepared.set(target.episode, prepared)
        return { projectDir, episode: target.episode, ready: true, digest: prepared.digest, shots: plan.shots.length,
          issues: [], renderer: capture.identity }
      } catch (error) {
        signal.throwIfAborted(); this.prepared.delete(target.episode)
        return { projectDir, episode: target.episode, ready: false, digest: null, shots: 0,
          issues: [error instanceof Error ? error.message : String(error)], renderer: null }
      }
    }, caller)
  }

  /**
   * Persist a tiny original-attempt claim before returning; media work belongs to the service queue.
   * @param input - Exact readiness digest, project and episode.
   * @returns The original admission, including after a lost reply; this method never waits for rendering.
   */
  @Remote
  admitEpisode(input: EpisodeAdmissionInput): Promise<EpisodeDeliveryStatus> {
    const request = admissionSchema.parse(input), caller = this.ctx.invocation?.signal
    return this.owned(async (signal) => {
      const projectDir = await canonical(request.projectDir)
      const target: EpisodeStatusInput = { projectDir, episode: request.episode, digest: request.digest }
      return this.serial(async () => {
        signal.throwIfAborted()
        if (this.paused || this.closing) throw new RemoteError('jubian-episode-delivery/paused', 'Episode admission is paused', {})
        const attempt = attemptId(target), root = join(projectDir, '.muse', 'episode-delivery', attempt)
        const existing = await this.readIntent(root, target)
        if (existing !== undefined) {
          const current = await this.statusOf(existing, root)
          if (request.resume !== true || !current.canResume) return current
          signal.throwIfAborted()
          await this.writeState(root, { version: 1, attempt, digest: existing.digest, state: 'queued' })
          this.schedule(existing, root, start => start.then(() => this.resumeOriginal(existing, root)))
          return { ...current, state: 'queued', canResume: false }
        }
        const prepared = this.prepared.get(target.episode)
        if (prepared === undefined || prepared.plan.projectDir !== projectDir || prepared.digest !== target.digest) {
          throw new Error('Run readiness again for this exact episode selection')
        }
        prepared.capture.signal.throwIfAborted(); signal.throwIfAborted()
        await assertApprovedEpisodePlan(prepared.plan, signal)
        const identity: AttemptIdentity = { attempt, planSha256: target.digest, projectSha256: prepared.plan.projectSha256,
          rendererGeneration: prepared.capture.identity.generation, configurationSha256: prepared.capture.identity.configurationSha256 }
        const intent: Intent = { version: 1, kind: 'approved-episode-intent', projectDir, episode: target.episode,
          digest: target.digest, identity, planDigest: prepared.plan.digest, codeSha256: prepared.capture.identity.codeSha256,
          runtimeInputs: [...prepared.capture.runtimeInputs], planInputs: [...prepared.plan.inputHashes],
          sources: sourceFacts(prepared.sources) }
        await this.makeRoot(projectDir, attempt)
        const claim = await withFileLock(join(root, 'intent.json'), () => this.ctx.jubianVideoRecovery.admitApprovedSources(
          prepared.admission, signal, async (commitSignal) => {
            const raced = await this.readIntent(root, target)
            if (raced !== undefined) return { created: false, intent: raced }
            await assertApprovedEpisodePlan(prepared.plan, commitSignal)
            const evidence = await readdir(root)
            if (evidence.some(name => name !== 'intent.json.lock')) throw new Error('Episode intent is missing but attempt evidence remains; state is unknown')
            await this.publishJson(join(root, 'intent.json'), intent, commitSignal)
            await this.writeState(root, { version: 1, attempt, digest: target.digest, state: 'queued' })
            return { created: true, intent }
          }), { signal, waitMs: this.options.lockWaitMs })
        if (!claim.created) return this.statusOf(claim.intent, root)
        // Once the exact claim commits, caller cancellation cannot withdraw admitted work.
        this.schedule(intent, root, start => this.execute(intent, root, prepared, 'initial', start))
        return { projectDir, episode: target.episode, digest: target.digest, attempt, state: 'queued', canResume: false }
      })
    }, caller)
  }

  /**
   * Read one original durable admission without preparing, hashing media or admitting another attempt.
   * @param input - Exact project, episode and original readiness digest.
   * @returns Persisted publication measurements or targeted state; output is not a current-file verification.
   */
  @Remote
  episodeStatus(input: EpisodeStatusInput): Promise<EpisodeDeliveryStatus> {
    const request = statusInputSchema.parse(input)
    return this.owned(async () => {
      const target = { ...request, projectDir: await canonical(request.projectDir) }
      const root = join(target.projectDir, '.muse', 'episode-delivery', attemptId(target))
      const intent = await this.readIntent(root, target)
      if (intent !== undefined) return this.statusOf(intent, root)
      if (await this.hasFootprint(root)) {
        const attempt = attemptId(target); this.unknown.add(attempt)
        return { ...target, attempt, state: 'unknown', canResume: false, problem: 'Original intent is missing but attempt evidence remains' }
      }
      return { ...target, attempt: null, state: 'not-admitted', canResume: false }
    }, this.ctx.invocation?.signal, false)
  }

  private owned<Result>(run: (signal: AbortSignal) => Promise<Result>, caller?: AbortSignal, active = true): Promise<Result> {
    if (this.closing) return Promise.reject(new Error('Episode delivery is closing'))
    const signal = caller === undefined ? this.lifetime.signal : AbortSignal.any([caller, this.lifetime.signal])
    if (active) this.activeOperations++
    const operation = Promise.resolve().then(() => { signal.throwIfAborted(); return run(signal) })
    this.operations.add(operation)
    void operation.finally(() => { this.operations.delete(operation); if (active) this.activeOperations-- }).catch(() => {})
    return operation
  }
  private serial<Result>(run: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(run); this.queue = result.then(() => {}, () => {}); return result
  }
  private async makeRoot(project: string, attempt: EpisodeAttemptId): Promise<void> {
    let path = project
    for (const part of ['.muse', 'episode-delivery', attempt]) { path = join(path, part); await directory(path) }
  }
  private async publishJson(path: string, value: object, signal: AbortSignal): Promise<void> {
    const text = JSON.stringify(value) + '\n'
    if (Buffer.byteLength(text) > this.options.recordBytes) throw new Error('Episode record exceeds its configured budget')
    signal.throwIfAborted()
    const temporary = path + '.' + randomUUID() + '.prepared.json'
    await writeFileAtomic(temporary, text, { mode: 0o600, dirMode: 0o700 })
    try { signal.throwIfAborted(); await link(temporary, path) } finally { await unlink(temporary) }
  }
  private async existingRoot(root: string): Promise<boolean> {
    let info
    try { info = await lstat(root) } catch (error) { if (absent(error)) return false; throw error }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('Episode attempt root is not canonical')
    return true
  }
  private async hasFootprint(root: string): Promise<boolean> {
    return await this.existingRoot(root) && (await readdir(root)).some(name => name !== 'intent.json.lock')
  }
  private async readIntent(root: string, target: EpisodeStatusInput): Promise<Intent | undefined> {
    if (!await this.existingRoot(root)) return undefined
    const value = await readEpisodeRecord(join(root, 'intent.json'), this.options.recordBytes)
    if (value === undefined) return undefined
    const intent = intentSchema.parse(value)
    const mainProject = intent.planInputs.find(file => file.role === 'project' && file.path === join(intent.projectDir, 'project_config.json'))
    const logical = hash({ planDigest: intent.planDigest, sources: intent.sources,
      renderer: { configurationSha256: intent.identity.configurationSha256, codeSha256: intent.codeSha256,
        runtimeInputs: intent.runtimeInputs } })
    if (intent.projectDir !== target.projectDir || intent.episode !== target.episode || intent.digest !== target.digest
      || intent.identity.attempt !== attemptId(target) || intent.identity.planSha256 !== target.digest
      || episodePlanDigest(intent.projectDir, intent.planInputs) !== intent.planDigest
      || mainProject?.sha256 !== intent.identity.projectSha256 || logical !== intent.digest) {
      throw new Error('Episode immutable admission identity changed')
    }
    return intent
  }
  private async writeState(root: string, state: StoredState): Promise<void> {
    const text = JSON.stringify(state) + '\n'
    if (Buffer.byteLength(text) > this.options.recordBytes) throw new Error('Episode state exceeds its configured budget')
    await writeFileAtomic(join(root, 'state.json'), text, { mode: 0o600 })
  }
  private async statusOf(intent: Intent, root: string): Promise<EpisodeDeliveryStatus> {
    const ownerBefore = this.work.get(intent.identity.attempt), pendingBefore = ownerBefore?.pending === true
    const value = await readEpisodeRecord(join(root, 'state.json'), this.options.recordBytes)
    const state = value === undefined ? undefined : stateSchema.parse(value)
    if (state !== undefined && (state.attempt !== intent.identity.attempt || state.digest !== intent.digest)) throw new Error('Episode state belongs to another admission')
    const ownerAfter = this.work.get(intent.identity.attempt)
    const locallyActive = pendingBefore || ownerAfter?.pending === true || ownerBefore !== ownerAfter
    let current = state?.state ?? 'unknown'
    if (!locallyActive && (current === 'queued' || current === 'preparing' || current === 'running' || current === 'stopping')) current = 'unknown'
    let output: z.infer<typeof outputSchema> | undefined
    if (state?.output !== undefined || current === 'completed') {
      const raw = await readEpisodeRecord(join(root, 'receipt.json'), this.options.recordBytes)
      if (raw === undefined) current = 'unknown'
      else {
        const receipt = receiptSchema.parse(raw)
        const expected = 'exports/' + `Muse-episode-${String(intent.episode).padStart(2, '0')}-${intent.digest}.mp4`
        if (!this.sameAttempt(receipt.identity, intent.identity) || receipt.output.path !== expected
          || receipt.execution !== state?.execution || state.output === undefined || !same(receipt.output, state.output)) throw new Error('Episode state and publication receipt disagree')
        output = receipt.output
      }
    }
    if (current === 'unknown') this.unknown.add(intent.identity.attempt)
    else if (current === 'completed' || current === 'cancelled' || current === 'failed') {
      const previous = await this.previousDrain(intent, root)
      if (current === 'completed') {
        if (previous.proof?.result === 'completed' && output !== undefined && previous.proof.identity.execution === state?.execution
          && previous.proof.candidate.outputSha256 === output.sha256 && previous.proof.candidate.outputBytes === output.bytes) {
          this.unknown.delete(intent.identity.attempt)
        } else { current = 'unknown'; this.unknown.add(intent.identity.attempt) }
      } else if (previous.proof?.result === current) this.unknown.delete(intent.identity.attempt)
    }
    return { projectDir: intent.projectDir, episode: intent.episode, digest: intent.digest, attempt: intent.identity.attempt,
      state: current, canResume: !locallyActive && await this.resumable(intent, root, current),
      ...(state?.execution === undefined ? {} : { execution: brandString<EpisodeExecutionId>(state.execution) }),
      ...(output === undefined ? {} : { output }),
      ...(state?.cancellationReason === undefined ? {} : { cancellationReason: state.cancellationReason }),
      ...(state?.problem === undefined ? {} : { problem: state.problem }) }
  }

  private schedule(intent: Intent, root: string, run: (start: Promise<void>) => Promise<void>): void {
    this.unknown.delete(intent.identity.attempt)
    const done = run(this.tail).catch(async (error: unknown) => {
      this.unknown.add(intent.identity.attempt)
      await this.writeState(root, { version: 1, attempt: intent.identity.attempt, digest: intent.digest,
        state: 'unknown', problem: error instanceof Error ? error.message : String(error) })
      throw error
    })
    const entry: Work = { done, pending: true }
    this.work.set(intent.identity.attempt, entry)
    this.tail = done.then(() => {}, () => {})
    void done.then(() => { entry.pending = false }, () => { entry.pending = false })
  }

  private sameAttempt(left: AttemptIdentity, right: AttemptIdentity): boolean {
    return left.attempt === right.attempt && left.planSha256 === right.planSha256 && left.projectSha256 === right.projectSha256
      && left.rendererGeneration === right.rendererGeneration && left.configurationSha256 === right.configurationSha256
  }

  private async previousDrain(intent: Intent, root: string): Promise<{ running: boolean; unarmed?: boolean; proof?: import('./episode-delivery.ts').ExecutionDrain }> {
    const rawJob = await readEpisodeRecord(join(root, 'job.json'), this.options.recordBytes)
    const record = rawJob === undefined ? undefined : parseEpisodeDeliveryJobRecord(rawJob)
    if (record !== undefined && (record.projectDir !== intent.projectDir || !this.sameAttempt(record.identity, intent.identity))) {
      throw new Error('Episode job identity changed')
    }
    const raw = await readEpisodeRecord(join(root, 'execution.json'), this.options.recordBytes)
    if (raw === undefined) {
      if (record !== undefined) return { running: record.executionRef !== null, unarmed: record.executionRef === null }
      const names = await readdir(root)
      const cancellations = names.filter(name => name.startsWith('cancel-') && name.endsWith('.json'))
      const notDispatched = new Set<string>()
      for (const name of cancellations) {
        const cancellation = cancellationSchema.parse(await readEpisodeRecord(join(root, name), this.options.recordBytes))
        if (cancellation.attempt !== intent.identity.attempt || name !== 'cancel-' + cancellation.execution + '.json') {
          throw new Error('Episode cancellation belongs to another execution')
        }
        if (!cancellation.dispatched) notDispatched.add(cancellation.execution)
      }
      const evidence = names.some(name => name === 'execution.json' || name.startsWith('admitted-') || name.startsWith('drained-')
        || name.startsWith('publication-') || (name.startsWith('cancel-') && !notDispatched.has(name.slice(7, -5)))
        || (z.uuid().safeParse(name).success && !notDispatched.has(name)))
      return { running: evidence, unarmed: !evidence }
    }
    const running = runningExecutionSchema.parse(raw)
    if (!this.sameAttempt(running.identity, intent.identity)) throw new Error('Episode running identity changed')
    if (record?.executionRef === null || record?.executionRef === undefined || !same(record.executionRef, running)) {
      return { running: true }
    }
    const value = await readEpisodeRecord(join(root, 'drained-' + running.identity.execution + '.json'), this.options.recordBytes)
    if (value === undefined) return { running: true }
    const proof = executionDrainSchema.parse(value)
    if (!same(proof.identity, running.identity) || proof.guardianPid !== running.guardianPid) throw new Error('Episode drain does not match its armed execution')
    return { running: true, proof }
  }

  private async resumable(intent: Intent, root: string, state: StoredState['state']): Promise<boolean> {
    if (state === 'completed') {
      const receipt = await readEpisodeRecord(join(root, 'receipt.json'), this.options.recordBytes)
      if (receipt !== undefined) {
        const parsed = receiptSchema.parse(receipt)
        if (!this.sameAttempt(parsed.identity, intent.identity)) throw new Error('Episode receipt identity changed')
        let info
        try { info = await lstat(join(intent.projectDir, parsed.output.path)) }
        catch (error) { if (absent(error)) return true; throw error }
        return !info.isFile() || info.isSymbolicLink() || info.size !== parsed.output.bytes
      }
    }
    const previous = await this.previousDrain(intent, root)
    return previous.proof !== undefined || previous.unarmed === true
  }

  private async resumeOriginal(intent: Intent, root: string): Promise<void> {
    const recovered = await this.recoverPublication(intent, root, this.lifetime.signal)
    if (recovered !== undefined) {
      await this.writeState(root, { version: 1, attempt: intent.identity.attempt, digest: intent.digest,
        state: 'completed', execution: recovered.execution, output: recovered.output })
      return
    }
    const readiness = await this.episodeReadiness({ projectDir: intent.projectDir, episode: intent.episode })
    const prepared = this.prepared.get(intent.episode)
    if (!readiness.ready || readiness.digest !== intent.digest || prepared === undefined
      || prepared.plan.digest !== intent.planDigest || prepared.capture.identity.configurationSha256 !== intent.identity.configurationSha256
      || prepared.capture.identity.codeSha256 !== intent.codeSha256 || !same(prepared.capture.runtimeInputs, intent.runtimeInputs)
      || !same(sourceFacts(prepared.sources), intent.sources)) throw new Error('Original episode inputs or renderer facts no longer match; no execution was started')
    await this.execute(intent, root, prepared, 'explicit-retry')
  }

  private async recoverPublication(intent: Intent, root: string, signal: AbortSignal): Promise<z.infer<typeof receiptSchema> | undefined> {
    const previous = await this.previousDrain(intent, root)
    if (previous.proof?.result !== 'completed') return undefined
    const proof = previous.proof, receiptPath = join(root, 'receipt.json')
    const raw = await readEpisodeRecord(receiptPath, this.options.recordBytes)
      ?? await readEpisodeRecord(join(root, 'publication-' + proof.identity.execution + '.json'), this.options.recordBytes)
    if (raw === undefined) return undefined
    const receipt = receiptSchema.parse(raw)
    const expectedPath = 'exports/' + `Muse-episode-${String(intent.episode).padStart(2, '0')}-${intent.digest}.mp4`
    if (!this.sameAttempt(receipt.identity, intent.identity) || receipt.execution !== proof.identity.execution
      || receipt.output.path !== expectedPath || receipt.output.sha256 !== proof.candidate.outputSha256
      || receipt.output.bytes !== proof.candidate.outputBytes) throw new Error('Prepared episode publication does not match its drain proof')
    const exports = join(intent.projectDir, 'exports')
    let exportInfo
    try { exportInfo = await lstat(exports) } catch (error) { if (absent(error)) return undefined; throw error }
    if (!exportInfo.isDirectory() || exportInfo.isSymbolicLink() || await realpath(exports) !== exports) {
      throw new Error('Episode destination directory is not canonical')
    }
    let version: EpisodeFileVersion
    try { version = await hashEpisodeFile(join(intent.projectDir, receipt.output.path), signal) }
    catch (error) { if (absent(error)) return undefined; throw error }
    if (version.sha256 !== receipt.output.sha256 || version.bytes !== receipt.output.bytes) throw new Error('Episode destination is occupied by different bytes')
    await this.serial(async () => {
      await assertEpisodeFileVersion(version, signal)
      const current = await readEpisodeRecord(receiptPath, this.options.recordBytes)
      if (current === undefined) await this.publishJson(receiptPath, receipt, this.lifetime.signal)
      else if (!same(receiptSchema.parse(current), receipt)) throw new Error('Episode receipt changed before repair')
    })
    return receipt
  }

  private async execute(intent: Intent, root: string, prepared: Prepared, retry: 'initial' | 'explicit-retry',
    start: Promise<void> = Promise.resolve()): Promise<void> {
    const execution = brandString<EpisodeExecutionId>(randomUUID()), base = { version: 1 as const,
      attempt: intent.identity.attempt, digest: intent.digest, execution }
    let cancellationReason: EpisodeCancellationReason | undefined
    let dispatched = false
    const providerSignal = AbortSignal.any([this.lifetime.signal, prepared.capture.signal, prepared.admission.signal])
    const beforeCancel = async (reason: 'configuration-changed' | 'provider-disposed' | 'caller-cancelled'): Promise<void> => {
      const cause = reason === 'configuration-changed' || prepared.admission.signal.aborted ? 'configuration-changed' : 'provider-disposed'
      const cancellation = cancellationSchema.parse({ version: 1, attempt: intent.identity.attempt, execution, dispatched, reason: cause })
      await this.publishJson(join(root, 'cancel-' + execution + '.json'), cancellation, new AbortController().signal)
      cancellationReason = cause
    }
    try {
      await this.ctx.jubianVideoRecovery.withApprovedSources({ items: prepared.plan.shots.map(shot => shot.input),
        metadataMaxBytes: this.options.metadataMaxBytes }, providerSignal, async (lease) => {
        await start
        lease.assertActive()
        await this.writeState(root, { ...base, state: 'preparing' })
        if (!same(sourceFacts(lease.sources), intent.sources)) throw new Error('Episode original approved sources changed')
        await assertApprovedEpisodePlan(prepared.plan, lease.signal)
        const job = await createEpisodeDeliveryJob({ projectDir: intent.projectDir, identity: intent.identity,
          recordBytes: this.options.recordBytes, lockWaitMs: this.options.lockWaitMs, signal: lease.signal })
        const executionRoot = join(root, execution); await directory(executionRoot)
        const stageRoot = join(executionRoot, 'stage'); await directory(stageRoot)
        await this.writeState(root, { ...base, state: 'running' })
        const sources = await Promise.all(lease.sources.map(async (source, index) => {
          const version = await hashEpisodeFile(source.source.path, lease.signal)
          if (version.sha256 !== source.source.sha256) throw new Error('Episode source changed before staging')
          return { shot: index + 1, idempotencyKey: source.idempotencyKey, digest: source.digest,
            sha256: source.source.sha256, path: source.source.path, bytes: version.bytes }
        }))
        lease.assertActive()
        dispatched = true
        const result = await prepared.capture.render({ identity: intent.identity, execution, retry, job, stageRoot, sources }, lease.signal)
        await this.finishResult(intent, root, base, result, lease, prepared.plan, cancellationReason)
      }, beforeCancel, prepared.admission)
    } catch (error) {
      const previous = await this.previousDrain(intent, root)
      const unknown = error instanceof ApprovedSourceCancellationError || (previous.running && previous.proof === undefined)
        || previous.proof?.result === 'completed'
      if (unknown) this.unknown.add(intent.identity.attempt)
      const state = unknown ? 'unknown' : previous.proof?.result === 'cancelled' || cancellationReason !== undefined ? 'cancelled' : 'failed'
      await this.writeState(root, { ...base, state,
        ...(cancellationReason === undefined ? {} : { cancellationReason }),
        problem: error instanceof Error ? error.message : String(error) })
      if (unknown) throw error
    }
  }

  private async finishResult(intent: Intent, root: string,
    base: { version: 1; attempt: EpisodeAttemptId; digest: Sha256; execution: EpisodeExecutionId },
    result: EpisodeRenderResult, lease: import('./types.ts').ApprovedVideoSourceLease, plan: ApprovedEpisodePlan,
    cancellationReason: EpisodeCancellationReason | undefined): Promise<void> {
    if (result.kind === 'unknown') {
      runningExecutionSchema.parse(result.previous); this.unknown.add(intent.identity.attempt)
      await this.writeState(root, { ...base, state: 'unknown', problem: result.diagnostic }); return
    }
    const proof = executionDrainSchema.parse(result.proof)
    if (!this.sameAttempt(proof.identity, intent.identity)
      || (result.kind === 'drained' && proof.identity.execution !== base.execution)) throw new Error('Renderer returned another physical execution proof')
    const durable = await this.previousDrain(intent, root)
    if (durable.proof === undefined || !same(durable.proof, proof)) throw new Error('Renderer result has no matching durable drain proof')
    const actualBase = { ...base, execution: proof.identity.execution }
    if (result.kind === 'retry-required') {
      await this.writeState(root, { ...base, state: 'unknown', problem: 'Previous execution requires explicit reconciliation' })
      this.unknown.add(intent.identity.attempt); return
    }
    if (proof.result !== 'completed') {
      await this.writeState(root, { ...base, state: proof.result,
        ...(cancellationReason === undefined ? {} : { cancellationReason }) }); return
    }
    const candidate = result.candidate as ApprovedEpisodeCandidate
    if (proof.candidate.outputSha256 !== candidate.sha256 || proof.candidate.outputBytes !== candidate.bytes) {
      throw new Error('Candidate disagrees with guardian drain proof')
    }
    const publish = await this.preparePublication(intent, root, proof.identity.execution, candidate, lease.signal)
    const output = await lease.commit(async (signal) => {
      await assertApprovedEpisodePlan(plan, signal)
      return publish(signal)
    })
    await this.writeState(root, { ...actualBase, state: 'completed', output })
  }

  private async preparePublication(intent: Intent, root: string, execution: EpisodeExecutionId,
    candidate: ApprovedEpisodeCandidate, signal: AbortSignal): Promise<(signal: AbortSignal) => Promise<z.infer<typeof outputSchema>>> {
    const rel = relative(root, candidate.path)
    if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || await realpath(candidate.path) !== candidate.path) {
      throw new Error('Episode candidate escapes its private attempt')
    }
    const actual = await hashEpisodeFile(candidate.path, signal)
    if (actual.sha256 !== candidate.sha256 || actual.bytes !== candidate.bytes) throw new Error('Episode candidate changed before publication')
    const exports = join(intent.projectDir, 'exports'); await directory(exports)
    const path = join(exports, `Muse-episode-${String(intent.episode).padStart(2, '0')}-${intent.digest}.mp4`)
    const output = { path: relative(intent.projectDir, path).split(sep).join('/'), sha256: actual.sha256, bytes: actual.bytes }
    let existing: EpisodeFileVersion | undefined
    try { existing = await hashEpisodeFile(path, signal) } catch (error) { if (!absent(error)) throw error }
    if (existing !== undefined && (existing.sha256 !== actual.sha256 || existing.bytes !== actual.bytes)) throw new Error('Episode destination is occupied by different bytes')
    const prepared = join(root, 'publish-' + execution + '.mp4')
    let target: { readonly kind: 'prepared' | 'existing'; readonly version: EpisodeFileVersion }
    if (existing === undefined) {
      try { await copyFile(candidate.path, prepared, constants.COPYFILE_EXCL) }
      catch (error) { if (!occupied(error)) throw error }
      const copy = await hashEpisodeFile(prepared, signal)
      target = { kind: 'prepared', version: copy }
      await assertEpisodeFileVersion(actual, signal)
      if (copy.sha256 !== actual.sha256 || copy.bytes !== actual.bytes) throw new Error('Prepared episode publication changed')
    } else target = { kind: 'existing', version: existing }
    const receipt = receiptSchema.parse({ version: 1, kind: 'approved-episode-delivery', identity: intent.identity,
      execution, output, width: candidate.width, height: candidate.height, durationUs: candidate.durationUs, video: true, audio: true })
    const publishMetadata = join(root, 'publication-' + execution + '.json')
    const alreadyPrepared = await readEpisodeRecord(publishMetadata, this.options.recordBytes)
    if (alreadyPrepared === undefined) await this.publishJson(publishMetadata, receipt, signal)
    else if (!same(receiptSchema.parse(alreadyPrepared), receipt)) throw new Error('Prepared publication metadata conflicts')
    const receiptPath = join(root, 'receipt.json'), prior = await readEpisodeRecord(receiptPath, this.options.recordBytes)
    if (prior !== undefined && !same(receiptSchema.parse(prior), receipt)) throw new Error('Episode publication receipt conflicts')
    return async (commitSignal) => {
      commitSignal.throwIfAborted()
      const preparedVersion = target.version
      if (target.kind === 'prepared') {
        await assertEpisodeFileVersion(preparedVersion, commitSignal)
        await link(prepared, path)
        const linked = await lstat(path), retained = await lstat(prepared)
        if (!linked.isFile() || linked.dev !== preparedVersion.dev || linked.ino !== preparedVersion.ino
          || linked.size !== preparedVersion.bytes || linked.mtimeMs !== preparedVersion.mtimeMs
          || retained.dev !== linked.dev || retained.ino !== linked.ino || retained.size !== linked.size
          || retained.mtimeMs !== linked.mtimeMs || retained.ctimeMs !== linked.ctimeMs) {
          throw new Error('Published episode differs from its verified prepared file')
        }
      }
      else await assertEpisodeFileVersion(target.version, commitSignal)
      if (prior === undefined) {
        try { await this.publishJson(receiptPath, receipt, commitSignal) } catch (error) {
          const current = await readEpisodeRecord(receiptPath, this.options.recordBytes)
          if (!occupied(error) || !same(receiptSchema.parse(current), receipt)) throw error
        }
      }
      return output
    }
  }
}

/** Authenticated local project recovery, review and exact direct MP4 delivery. */
import { lstat, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isAbsolute, join, relative } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { JubianClient, JubianLedger, JubianLedgerRecord } from '@deepseek-ai/dsh-jubian'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { checkVideoMedia, decodeVideoFile, VideoMediaDrainError, type VideoMediaDecoder } from './video-media-check.ts'
import { recordedVideoPreview, recoveryProject, type RecoveryProject } from './video-recovery-project.ts'
import {
  adoptRecoveredVideo, materializeApprovedProviderVideo, publishApprovedVideo, readApprovedVideoDelivery,
  reviewRecoveredVideo, runVideoRecovery, recoverApprovedVideoDelivery, VideoDeliveryFileError,
  readApprovedVideoSourceMetadata, verifyApprovedVideoSource, assertApprovedVideoSourceVersion,
} from './video-recovery.ts'
import type {
  ApprovedClipDeliveryInput, VideoArtifactSha256, VideoRecoveryAdoptionInput, VideoRecoveryConfigurationInput,
  VideoRecoveryDigest, VideoRecoveryReview, VideoRecoveryReviewInput, VideoRecoveryStatus,
  ApprovedVideoSource, ApprovedVideoSourceMetadata, ApprovedVideoSourceVersion, ApprovedVideoSourceRequest,
  ApprovedVideoSourceLease, ApprovedVideoSourceAdmission, ApprovedVideoSourceCancellationReason,
  VideoRecoveryProjectDigest, VideoRecoveryIntentDigest,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authenticated project-local recovery and human video decisions. */
    jubianVideoRecovery: JubianVideoRecovery
  }
}

/** Trusted deployment inputs for the dynamic Settings recovery service. */
export interface JubianVideoRecoveryOptions {
  readonly ledger: JubianLedger
  readonly settingsPath: string
  readonly clientForProject: (projectDir: string) => JubianClient
  /** Missing decoder allows reports to be read but refuses enabling or adopting media. */
  readonly ffmpegPath: string | undefined
  readonly intervalMs: number
  readonly decodeTimeoutMs: number
  readonly decodeGraceMs: number
  readonly decodeMaxOutputBytes: number
}

const configurationSchema = z.object({ enabled: z.boolean(), projectDir: z.string().nullable() })
type Configuration = z.infer<typeof configurationSchema>
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const evidenceSchema = z.object({
  idempotency_key: z.string(), task_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['awaiting_review', 'provider_failed']),
  media_checks: z.array(z.object({ sha256: z.string(), video: z.boolean(), audio: z.boolean() })),
})
const derivativeSchema = z.object({ path: z.string(), sha256: digestSchema, video: z.boolean(), audio: z.boolean() })
const reasonSchema = z.string().trim().min(1).max(1000)
const decisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), digest: digestSchema, reason: z.undefined().optional() }),
  z.object({ action: z.literal('reject'), digest: digestSchema, reason: reasonSchema.optional() }),
])
const reopenedSchema = z.object({ digest: digestSchema, rejectionReason: z.string().nullable(), reason: reasonSchema })
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('provider'), path: z.string(),
    sha256: digestSchema.transform(value => brandString<VideoArtifactSha256>(value)),
    state: z.enum(['verified', 'unmaterialized', 'changed', 'unreadable']) }),
  z.object({ kind: z.literal('derivative'), path: z.string(),
    sha256: digestSchema.transform(value => brandString<VideoArtifactSha256>(value)),
    state: z.enum(['verified', 'missing', 'changed', 'unreadable']) }),
  z.object({ kind: z.literal('none'), state: z.literal('unverifiable') }),
])

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function refusal(message: string, cause?: unknown): RemoteError {
  return new RemoteError('jubian-video-recovery/rejected', message, {}, { cause })
}

async function readConfiguration(path: string, signal: AbortSignal): Promise<Configuration> {
  let entry
  try { entry = await lstat(path) } catch (error) {
    if (missing(error)) return { enabled: false, projectDir: null }
    throw error
  }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Recovery settings must be a regular file')
  const saved = configurationSchema.parse(JSON.parse(await readFile(path, { encoding: 'utf8', signal })))
  if ((saved.enabled && saved.projectDir === null) || (saved.projectDir !== null && !isAbsolute(saved.projectDir))) {
    throw new Error('Recovery settings require an absolute project directory')
  }
  return saved
}

function reportView(report: Awaited<ReturnType<typeof reviewRecoveredVideo>>, key: string): VideoRecoveryReview {
  const evidence = evidenceSchema.parse(report.evidence)
  const digest = brandString<VideoRecoveryDigest>(digestSchema.parse(report.digest))
  const derivative = report.derivative === null ? null : derivativeSchema.parse(report.derivative)
  const decision = report.decision === null ? null : decisionSchema.parse(report.decision)
  const reopened = reopenedSchema.optional().parse(report.reopened_from)
  return {
    idempotencyKey: key, taskId: evidence.task_id, status: evidence.status, digest, source: sourceSchema.parse(report.source),
    mediaChecks: derivative === null ? evidence.media_checks : [
      { sha256: derivative.sha256, video: derivative.video, audio: derivative.audio },
    ],
    ...(derivative === null ? {} : { derivative: {
      path: derivative.path, sha256: brandString<VideoArtifactSha256>(derivative.sha256),
    } }),
    decision: decision?.action ?? null,
    ...(decision?.reason === undefined ? {} : { reason: decision.reason }),
    ...(reopened === undefined ? {} : { reopenedFrom: {
      ...reopened, digest: brandString<VideoRecoveryDigest>(reopened.digest),
    } }),
  }
}

function approvedSourceSha(report: VideoRecoveryReview): VideoArtifactSha256 | undefined {
  const [check] = report.mediaChecks
  if (report.decision !== 'approve' || report.status !== 'awaiting_review'
    || report.mediaChecks.length !== 1 || !check?.video || !check.audio) return undefined
  if (report.derivative !== undefined) return report.derivative.sha256
  const digest = /^sha256:([a-f0-9]{64})$/u.exec(check.sha256)?.[1]
  return digest === undefined ? undefined : brandString<VideoArtifactSha256>(digest)
}

async function withDelivery(project: string, report: VideoRecoveryReview, signal: AbortSignal): Promise<VideoRecoveryReview> {
  const sha = approvedSourceSha(report)
  if (sha === undefined) return report
  try {
    const directDelivery = await readApprovedVideoDelivery(project, report.taskId, report.digest, sha, signal)
    return directDelivery === undefined ? report : { ...report, directDelivery }
  } catch (error) {
    signal.throwIfAborted()
    return { ...report, directDeliveryProblem: error instanceof VideoDeliveryFileError ? error.problem : 'unreadable' }
  }
}

/** The source operation is cancelled only after its durable cancellation hook. */
export class ApprovedSourceCancelled extends Error {
  /** @param reason - Source owner that stopped this generation or caller. */
  constructor(readonly reason: ApprovedVideoSourceCancellationReason) { super('Approved source cancelled: ' + reason) }
}

/** A failed cancellation journal leaves the operation fenced for reconciliation. */
export class ApprovedSourceCancellationError extends Error {}

interface SourceSelection {
  accepting: boolean
  readonly controller: AbortController
  readonly operations: Set<Promise<unknown>>
}
function sourceSelection(): SourceSelection {
  return { accepting: true, controller: new AbortController(), operations: new Set() }
}
function sourceDrainFailure(error: unknown): boolean {
  return error instanceof VideoMediaDrainError || error instanceof ApprovedSourceCancellationError
}

/** Dynamic project selection, read-only recovery and explicit human decisions. */
export class JubianVideoRecovery extends TypertRemoteService {
  static inject = ['subprocess']
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly sourceCommit = new AsyncLocalStorage<boolean>()
  private readonly admissionFacts = new WeakMap<ApprovedVideoSourceAdmission, {
    readonly generation: SourceSelection
    readonly request: ApprovedVideoSourceRequest
    readonly versions: readonly ApprovedVideoSourceVersion[]
  }>()
  private selection = sourceSelection()
  private configurationChanges: Promise<void> = Promise.resolve()
  private configuration: Configuration = { enabled: false, projectDir: null }
  private closing = false
  private queue: Promise<void> = Promise.resolve()
  private worker: { controller: AbortController; done: Promise<void> } | undefined

  /**
   * @param ctx - Context owning the service and its native subprocess dependency.
   * @param options - Deployment-controlled ledger, paths and limits.
   */
  constructor(ctx: Context, private readonly options: JubianVideoRecoveryOptions) {
    super(ctx, 'jubianVideoRecovery')
    ctx.effect(() => async () => {
      this.closing = true
      this.selection.accepting = false
      this.selection.controller.abort(new ApprovedSourceCancelled('provider-disposed'))
      this.lifetime.abort(new Error('Video recovery disposed'))
      this.worker?.controller.abort()
      const settled = await Promise.allSettled([...this.operations, this.queue, this.configurationChanges, this.stopWorker()])
      this.sourceCommit.disable()
      const incomplete = settled.find(result => result.status === 'rejected' && sourceDrainFailure(result.reason))
      if (incomplete?.status === 'rejected') throw incomplete.reason
    })
  }

  /** Load the saved switch before accepting browser operations. */
  async [Service.init](): Promise<void> {
    await this.owned(undefined, async (signal) => {
      const saved = await readConfiguration(this.options.settingsPath, signal)
      signal.throwIfAborted()
      this.configuration = saved
      if (saved.enabled && saved.projectDir !== null) {
        let project: RecoveryProject
        try { project = await recoveryProject(saved.projectDir, signal) }
        catch (error) {
          signal.throwIfAborted()
          this.ctx.logger.warn('Saved video recovery project could not resume: %s', String(error))
          return
        }
        const decoder = await this.decoder(signal)
        if (decoder !== undefined) this.startWorker(project.directory, decoder)
      }
    })
  }

  /**
   * Read a consistent selected-project view and current artifact checks.
   * @returns Saved selection and reports without provider URLs or credentials.
   */
  @Remote
  status(): Promise<VideoRecoveryStatus> {
    const caller = this.ctx.invocation?.signal
    return this.owned(caller, signal => this.statusSnapshot(this.configuration, signal))
  }

  /**
   * Persist a selected project and replace its single background worker.
   * @param input - New switch and optional absolute project path.
   * @returns Committed selection and reports for that project.
   */
  @Remote
  configure(input: VideoRecoveryConfigurationInput): Promise<VideoRecoveryStatus> {
    const caller = this.ctx.invocation?.signal
    return this.owned(caller, (signal) => {
      const change = this.configurationChanges.then(() => this.replaceConfiguration(input, signal))
      this.configurationChanges = change.then(() => {}, () => {})
      return change
    })
  }

  /**
   * Own a verified batch without holding the recovery queue during consumer work.
   * Consumers must await their work and commit prepared publication once; they must
   * not call recovery operations from a commit or cancellation-journal callback.
   * @param input - Original approved keys/digests and the consumer Config's metadata budget.
   * @param caller - Consumer operation cancellation, never an implicit invocation signal.
   * @param consume - Long stage/render work with one final short source-owner commit.
   * @param beforeCancel - Optional durable cancellation-intent write before the consumer signal aborts.
   * @param admission - Optional readiness generation for already admitted queued work.
   * @returns The consumer result after all source checks and cancellation IO settle.
   */
  withApprovedSources<Result>(input: ApprovedVideoSourceRequest, caller: AbortSignal,
    consume: (lease: ApprovedVideoSourceLease) => Promise<Result>,
    beforeCancel?: (reason: ApprovedVideoSourceCancellationReason) => Promise<void>,
    admission?: ApprovedVideoSourceAdmission): Promise<Result> {
    if (!Number.isSafeInteger(input.metadataMaxBytes) || input.metadataMaxBytes < 1 || input.items.length === 0
      || new Set(input.items.map(item => item.idempotencyKey)).size !== input.items.length) {
      return Promise.reject(refusal('Source batches require unique original keys and a validated metadata budget'))
    }
    const request: ApprovedVideoSourceRequest = { metadataMaxBytes: input.metadataMaxBytes,
      items: input.items.map(item => ({ idempotencyKey: item.idempotencyKey, digest: item.digest })) }
    const captured = admission === undefined ? undefined : this.admissionFacts.get(admission)
    if (admission !== undefined && captured === undefined) return Promise.reject(refusal('Source admission belongs to another recovery owner'))
    const generation = captured?.generation ?? this.selection
    if (!generation.accepting && admission === undefined) return Promise.reject(refusal('The selected source generation is closing'))
    const operation = this.owned(undefined, async () => {
      const controller = new AbortController(), tasks: Promise<unknown>[] = []
      let active = true, cancelling: Promise<void> | undefined
      let cancelFailure: { readonly error: unknown } | undefined
      const publication: { phase: 'unused' | 'pending' | 'committed' | 'failed' } = { phase: 'unused' }
      const track = <Value>(task: Promise<Value>): Promise<Value> => {
        tasks.push(task)
        void task.catch((_error: unknown) => { /* The lease joins and rethrows recorded task failures. */ })
        return task
      }
      const cancel = (reason: ApprovedVideoSourceCancellationReason): void => {
        if (cancelling !== undefined || publication.phase === 'committed') return
        cancelling = track(Promise.resolve().then(async () => {
          try { if (beforeCancel !== undefined) await this.sourceCommit.run(true, () => beforeCancel(reason)) }
          catch (error) { cancelFailure = { error } }
          finally { controller.abort(new ApprovedSourceCancelled(reason)) }
        }))
      }
      const onCaller = (): void => { cancel('caller-cancelled') }
      const onProvider = (): void => { cancel('provider-disposed') }
      const onGeneration = (): void => {
        const reason = generation.controller.signal.reason as ApprovedSourceCancelled
        cancel(reason.reason)
      }
      caller.addEventListener('abort', onCaller, { once: true })
      this.lifetime.signal.addEventListener('abort', onProvider, { once: true })
      generation.controller.signal.addEventListener('abort', onGeneration, { once: true })
      if (caller.aborted) onCaller()
      if (generation.controller.signal.aborted) onGeneration()
      const signal = controller.signal
      let outcome: { readonly ok: true; readonly value: Result } | { readonly ok: false; readonly error: unknown }
      try {
        const sources = await this.enqueue(signal, async () => {
          this.assertSelection(generation)
          return this.captureSources(request, signal)
        })
        const verify = async (): Promise<readonly ApprovedVideoSourceVersion[]> => {
          const versions: ApprovedVideoSourceVersion[] = []
          for (const source of sources) {
            const metadata: ApprovedVideoSourceMetadata = { idempotencyKey: source.idempotencyKey, digest: source.digest,
              taskId: source.taskId, kind: source.source.kind, path: relative(source.project.directory, source.source.path),
              sha256: source.source.sha256 }
            versions.push(await verifyApprovedVideoSource(source.project.directory, metadata, signal))
          }
          return versions
        }
        const continuing = (): void => {
          if (cancelling !== undefined) throw refusal('The approved source lease is stopping')
          signal.throwIfAborted()
        }
        const check = (versions: readonly ApprovedVideoSourceVersion[]): Promise<void> => this.enqueue(signal, async () => {
          continuing()
          await this.assertSources(generation, request, sources, versions, signal)
          continuing()
        })
        const usable = (): void => {
          if (!active || publication.phase !== 'unused') throw refusal('The approved source lease has ended or committed')
          if (this.sourceCommit.getStore()) throw refusal('Recovery operations cannot be nested inside a source commit')
          continuing()
        }
        const verified = await verify()
        await check(verified)
        const admission: ApprovedVideoSourceAdmission = Object.freeze({ sources, signal: generation.controller.signal })
        this.admissionFacts.set(admission, { generation, request, versions: verified })
        const lease: ApprovedVideoSourceLease = {
          sources, signal, admission, assertActive: usable,
          recheck: () => track(Promise.resolve().then(async () => { usable(); await check(await verify()) })),
          commit: <Value>(publish: (control: AbortSignal) => Promise<Value>): Promise<Value> => {
            try { usable() } catch (error) { const reason: Error = error as Error; return Promise.reject(reason) }
            publication.phase = 'pending'
            return track(Promise.resolve().then(async () => {
              const versions = await verify()
              return this.enqueue(signal, async () => {
                continuing()
                await this.assertSources(generation, request, sources, versions, signal)
                continuing()
                const value = await this.sourceCommit.run(true, () => publish(this.lifetime.signal))
                publication.phase = 'committed'
                return value
              })
            }).catch((error: unknown) => { publication.phase = 'failed'; throw error }))
          },
        }
        usable()
        const value = await consume(lease)
        if (publication.phase === 'unused') await lease.recheck()
        outcome = { ok: true, value }
      } catch (error) { outcome = { ok: false, error } }
      finally {
        active = false
        caller.removeEventListener('abort', onCaller)
        this.lifetime.signal.removeEventListener('abort', onProvider)
        generation.controller.signal.removeEventListener('abort', onGeneration)
      }
      const settled = await Promise.allSettled(tasks)
      if (cancelFailure !== undefined) throw new ApprovedSourceCancellationError('The cancellation intent could not be persisted',
        { cause: cancelFailure.error })
      if (!outcome.ok) throw outcome.error
      const failed = settled.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      if (publication.phase !== 'committed') signal.throwIfAborted()
      return outcome.value
    })
    generation.operations.add(operation)
    void operation.then(() => { generation.operations.delete(operation) }, (error: unknown) => {
      if (!sourceDrainFailure(error)) generation.operations.delete(operation)
    })
    return operation
  }

  /**
   * Serialize a tiny durable admission against the exact readiness generation and current approvals.
   * @param admission - Same-process facts captured by a completed source lease.
   * @param signal - Short admission caller cancellation.
   * @param publish - Prepared small journal IO; no hashing, copying, consumers or recovery calls.
   * @returns The committed admission; callers must retain any already written records after cancellation.
   */
  admitApprovedSources<Result>(admission: ApprovedVideoSourceAdmission, signal: AbortSignal,
    publish: (signal: AbortSignal) => Promise<Result>): Promise<Result> {
    return this.owned(signal, control => this.enqueue(control, async () => {
      const facts = this.admissionFacts.get(admission)
      if (facts === undefined) throw refusal('Source admission was not captured by this recovery owner')
      await this.assertSources(facts.generation, facts.request, admission.sources, facts.versions, control)
      control.throwIfAborted()
      return this.sourceCommit.run(true, () => publish(this.lifetime.signal))
    }))
  }

  /**
   * Read the saved project selection without scanning reports or reading source media.
   * @returns The saved canonical project path, or null when no selection is saved.
   */
  selectedProjectDirectory(): string | null { return this.configuration.projectDir }

  /**
   * Read, decide or reopen the exact displayed report once.
   * @param input - Original key, action and current digest for mutations.
   * @returns Active report and persisted decision.
   */
  @Remote
  review(input: VideoRecoveryReviewInput): Promise<VideoRecoveryReview> {
    const caller = this.ctx.invocation?.signal
    return this.owned(caller, signal => this.enqueue(signal, async () => {
      const project = await this.project(signal)
      await this.assertOwns(input.idempotencyKey, project, signal)
      const previous = reportView(
        await reviewRecoveredVideo(project.directory, input.idempotencyKey, undefined, signal), input.idempotencyKey)
      const reason = reasonSchema.optional().parse(input.reason)
      if ((reason !== undefined && input.action !== 'reject' && input.action !== 'reopen')
        || (input.action === 'reopen' && reason === undefined)) {
        throw refusal('A reopening requires a reason; only rejection or reopening accepts one')
      }
      if (input.action === 'read') return withDelivery(project.directory, previous, signal)
      const digest = digestSchema.parse(input.digest)
      if (previous.digest !== digest || previous.status !== 'awaiting_review') {
        throw refusal('Read the current report before recording a decision')
      }
      signal.throwIfAborted()
      return reportView(await reviewRecoveredVideo(project.directory, input.idempotencyKey, {
        action: input.action, digest, ...(reason === undefined ? {} : { reason }),
      }, signal, input.action === 'approve' ? () => this.options.clientForProject(project.directory) : undefined), input.idempotencyKey)
    }))
  }

  /**
   * Capture and decode a project-local derivative before review.
   * @param input - Original key, current digest and project-relative MP4 path.
   * @returns Updated report and actual captured-file checks.
   */
  @Remote
  adopt(input: VideoRecoveryAdoptionInput): Promise<VideoRecoveryReview> {
    const caller = this.ctx.invocation?.signal
    return this.owned(caller, signal => this.enqueue(signal, async () => {
      const project = await this.project(signal)
      await this.assertOwns(input.idempotencyKey, project, signal)
      const decoder = await this.decoder(signal)
      if (decoder === undefined) throw refusal('The Host FFmpeg decoder is unavailable')
      return reportView(await adoptRecoveredVideo(project.directory, input.idempotencyKey, digestSchema.parse(input.digest), input.path,
        path => decodeVideoFile(path, decoder, signal), signal), input.idempotencyKey)
    }))
  }

  /**
   * Publish exactly the approved MP4 without an editor or new generation.
   * @param input - Original key and approved report digest.
   * @returns Current report and verified direct-copy receipt.
   */
  @Remote
  deliverApprovedMp4(input: ApprovedClipDeliveryInput): Promise<VideoRecoveryReview> {
    const caller = this.ctx.invocation?.signal
    return this.owned(caller, signal => this.enqueue(signal, async () => {
      const project = await this.project(signal)
      await this.assertOwns(input.idempotencyKey, project, signal)
      const report = reportView(
        await reviewRecoveredVideo(project.directory, input.idempotencyKey, undefined, signal), input.idempotencyKey)
      const sha = approvedSourceSha(report)
      if (report.digest !== input.digest || sha === undefined) {
        throw refusal('Select an approved video with passing picture and audio checks')
      }
      const existing = await recoverApprovedVideoDelivery(project.directory, report.taskId, report.digest, sha, signal)
      if (existing !== undefined) {
        const current = reportView(
          await reviewRecoveredVideo(project.directory, input.idempotencyKey, undefined, signal), input.idempotencyKey)
        if (current.digest !== report.digest || approvedSourceSha(current) !== sha) throw refusal('The approval changed before delivery')
        return { ...current, directDelivery: existing }
      }
      if (report.derivative !== undefined && report.source.state !== 'verified') {
        throw refusal('The reviewed derivative source is unavailable; restore the exact approved file')
      }
      const source = report.derivative === undefined
        ? await materializeApprovedProviderVideo(project.directory, report.taskId, sha,
          () => this.options.clientForProject(project.directory), signal)
        : join(project.directory, report.derivative.path)
      const current = reportView(
        await reviewRecoveredVideo(project.directory, input.idempotencyKey, undefined, signal), input.idempotencyKey)
      if (current.digest !== report.digest || approvedSourceSha(current) !== sha) throw refusal('The approval changed before delivery')
      const directDelivery = await publishApprovedVideo(project.directory, report.taskId, report.digest, source, sha, signal)
      return { ...current, directDelivery }
    }))
  }

  private async replaceConfiguration(input: VideoRecoveryConfigurationInput, signal: AbortSignal): Promise<VideoRecoveryStatus> {
    const prepared = await this.enqueue(signal, async () => {
      const selected = input.projectDir ?? this.configuration.projectDir
      if (input.enabled && selected === null) throw refusal('Select a Jubian project before enabling recovery')
      const project = selected !== null && (input.enabled || input.projectDir !== undefined)
        ? await recoveryProject(selected, signal) : undefined
      const decoder = input.enabled ? await this.decoder(signal) : undefined
      if (input.enabled && decoder === undefined) throw refusal('The Host FFmpeg decoder is unavailable')
      const configuration = { enabled: input.enabled, projectDir: project?.directory ?? selected }
      signal.throwIfAborted()
      await writeFileAtomic(this.options.settingsPath, JSON.stringify(configuration) + '\n', { mode: 0o600, dirMode: 0o700 })
      const previous = this.selection
      previous.accepting = false
      previous.controller.abort(new ApprovedSourceCancelled('configuration-changed'))
      this.worker?.controller.abort()
      this.configuration = configuration
      return { previous, configuration, project, decoder }
    })
    const stopped = this.stopWorker()
    const settled = await Promise.allSettled([...prepared.previous.operations, stopped])
    const worker = settled.at(-1)
    if (worker?.status === 'rejected') throw worker.reason
    const incomplete = settled.find(result => result.status === 'rejected' && sourceDrainFailure(result.reason))
    if (incomplete?.status === 'rejected') throw incomplete.reason
    // A committed configuration completes its drain/activation even after caller disconnection.
    await this.enqueue(this.lifetime.signal, () => {
      this.selection = sourceSelection()
      if (!this.closing && prepared.configuration.enabled && prepared.project !== undefined && prepared.decoder !== undefined) {
        this.startWorker(prepared.project.directory, prepared.decoder)
      }
      return Promise.resolve()
    })
    signal.throwIfAborted()
    return this.statusSnapshot(prepared.configuration, signal)
  }

  private assertSelection(generation: SourceSelection): void {
    if (this.selection !== generation || !generation.accepting) throw refusal('The selected source generation changed')
  }

  private async captureSources(request: ApprovedVideoSourceRequest, signal: AbortSignal): Promise<readonly ApprovedVideoSource[]> {
    const selected = this.configuration.projectDir
    if (selected === null) throw refusal('Select a Jubian project first')
    const project = await recoveryProject(selected, signal, request.metadataMaxBytes)
    const captured = Object.freeze({ directory: project.directory, scriptId: project.scriptId,
      configurationDigest: brandString<VideoRecoveryProjectDigest>(project.configSha256) })
    const sources: ApprovedVideoSource[] = []
    for (const item of request.items) {
      const record = await this.options.ledger.find(item.idempotencyKey)
      const preview = await recordedVideoPreview(record, project, signal)
      if (record === undefined || preview === undefined) throw refusal('The original submission no longer belongs to this project')
      const metadata = await readApprovedVideoSourceMetadata(project.directory, item.idempotencyKey, request.metadataMaxBytes, signal)
      if (metadata.digest !== item.digest) throw refusal('The source approval changed')
      const intent = JSON.stringify({ idempotencyKey: record.idempotency_key, method: record.method, scriptId: record.script_id,
        requestSha256: record.request_sha256, beforeTaskIds: record.before_task_ids ?? null, preview })
      sources.push(Object.freeze({ idempotencyKey: item.idempotencyKey, digest: metadata.digest, taskId: metadata.taskId,
        intentDigest: brandString<VideoRecoveryIntentDigest>(createHash('sha256').update(intent).digest('hex')), project: captured,
        source: Object.freeze({ kind: metadata.kind, path: join(project.directory, metadata.path), sha256: metadata.sha256 }) }))
    }
    return Object.freeze(sources)
  }

  private async assertSources(generation: SourceSelection, request: ApprovedVideoSourceRequest,
    expected: readonly ApprovedVideoSource[], versions: readonly ApprovedVideoSourceVersion[], signal: AbortSignal): Promise<void> {
    this.assertSelection(generation)
    const current = await this.captureSources(request, signal)
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw refusal('Approved source facts changed before commit')
    for (const version of versions) await assertApprovedVideoSourceVersion(version, signal)
  }

  private async project(signal: AbortSignal): Promise<RecoveryProject> {
    const selected = this.configuration.projectDir
    if (selected === null) throw refusal('Select a Jubian project first')
    return recoveryProject(selected, signal)
  }

  private async assertOwns(key: string, project: RecoveryProject, signal: AbortSignal): Promise<void> {
    if (!await recordedVideoPreview(await this.options.ledger.find(key), project, signal)) {
      throw refusal('The original submission does not belong to the selected project')
    }
  }

  private async statusSnapshot(configuration: Configuration, signal: AbortSignal): Promise<VideoRecoveryStatus> {
    const decoder = await this.decoder(signal)
    const reports: VideoRecoveryReview[] = []
    if (configuration.projectDir !== null) {
      let project: RecoveryProject
      try { project = await recoveryProject(configuration.projectDir, signal) }
      catch (error) {
        signal.throwIfAborted()
        void error // Preserve the saved switch while allowing a replacement project to be selected.
        return { ...configuration, configurable: true, decoderAvailable: decoder !== undefined, reports, projectProblem: 'unavailable' }
      }
      for (const record of await this.options.ledger.records()) {
        if (!await this.owns(record, project, signal)) continue
        try {
          const report = reportView(
            await reviewRecoveredVideo(project.directory, record.idempotency_key, undefined, signal), record.idempotency_key)
          reports.push(await withDelivery(project.directory, report, signal))
        } catch (error) {
          signal.throwIfAborted()
          if (!missing(error)) throw refusal('A video recovery report cannot be read', error)
        }
      }
    }
    signal.throwIfAborted()
    return { ...configuration, configurable: true, decoderAvailable: decoder !== undefined, reports }
  }

  private async owns(record: JubianLedgerRecord, project: RecoveryProject, signal: AbortSignal): Promise<boolean> {
    return await recordedVideoPreview(record, project, signal) !== undefined
  }

  private async decoder(signal: AbortSignal): Promise<VideoMediaDecoder | undefined> {
    const configured = this.options.ffmpegPath
    if (configured === undefined) return undefined
    let ffmpegPath: string
    try { ffmpegPath = await this.ctx.subprocess.resolveExecutable(configured, undefined, signal) }
    catch (error) {
      signal.throwIfAborted()
      if (error instanceof SubprocessExecutableNotFoundError) return undefined
      throw error
    }
    return { subprocess: this.ctx.subprocess, ffmpegPath, timeoutMs: this.options.decodeTimeoutMs,
      graceMs: this.options.decodeGraceMs, maxOutputBytes: this.options.decodeMaxOutputBytes }
  }

  private startWorker(projectDir: string, decoder: VideoMediaDecoder): void {
    this.lifetime.signal.throwIfAborted()
    const controller = new AbortController()
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal])
    const done = runVideoRecovery(this.options.clientForProject(projectDir), this.options.ledger, projectDir,
      undefined, this.options.intervalMs, signal,
      () => { this.ctx.logger.warn('Video recovery read failed; retaining the original key for another check') },
      (url, control) => checkVideoMedia(url, decoder, control))
    this.worker = { controller, done }
    void done.catch((error: unknown) => {
      if (!signal.aborted) this.ctx.logger.warn('Video recovery worker stopped: %s', error instanceof Error ? error.message : String(error))
    })
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker
    if (worker === undefined) return
    worker.controller.abort()
    await worker.done
    if (this.worker === worker) this.worker = undefined
  }

  private enqueue<Result>(signal: AbortSignal, action: () => Promise<Result>): Promise<Result> {
    const next = this.queue.then(() => { signal.throwIfAborted(); return action() })
    this.queue = next.then(() => {}, () => {})
    return next
  }

  private owned<Result>(caller: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<Result>): Promise<Result> {
    if (this.sourceCommit.getStore()) return Promise.reject(refusal('Recovery operations cannot be nested inside a source commit'))
    if (this.closing) return Promise.reject(refusal('Video recovery is shutting down'))
    const signal = caller === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, caller])
    const operation = Promise.resolve().then(() => { signal.throwIfAborted(); return action(signal) })
    this.operations.add(operation)
    void operation.then(() => { this.operations.delete(operation) }, (error: unknown) => {
      // An unconfirmed native range remains owned even after its request failed.
      if (!sourceDrainFailure(error)) this.operations.delete(operation)
    })
    return operation
  }
}

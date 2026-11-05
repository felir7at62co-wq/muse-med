/** Authenticated local project recovery, review and exact direct MP4 delivery. */
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
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
} from './video-recovery.ts'
import type {
  ApprovedClipDeliveryInput, VideoArtifactSha256, VideoRecoveryAdoptionInput, VideoRecoveryConfigurationInput,
  VideoRecoveryDigest, VideoRecoveryReview, VideoRecoveryReviewInput, VideoRecoveryStatus,
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
  if (evidence.idempotency_key !== key) throw new Error('The video report belongs to another original key')
  const digest = brandString<VideoRecoveryDigest>(digestSchema.parse(report.digest))
  const derivative = report.derivative === null ? null : derivativeSchema.parse(report.derivative)
  const decision = report.decision === null ? null : decisionSchema.parse(report.decision)
  const reopened = reopenedSchema.optional().parse(report.reopened_from)
  if (decision !== null && decision.digest !== digest) throw new Error('The decision belongs to another report')
  return {
    idempotencyKey: key, taskId: evidence.task_id, status: evidence.status, digest,
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

/** Dynamic project selection, read-only recovery and explicit human decisions. */
export class JubianVideoRecovery extends TypertRemoteService {
  static inject = ['subprocess']
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
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
      this.lifetime.abort(new Error('Video recovery disposed'))
      this.worker?.controller.abort()
      const settled = await Promise.allSettled([...this.operations, this.queue, this.stopWorker()])
      const incomplete = settled.find(result => result.status === 'rejected' && result.reason instanceof VideoMediaDrainError)
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
    return this.owned(caller, signal => this.enqueue(signal, async () => {
      const selected = input.projectDir ?? this.configuration.projectDir
      if (input.enabled && selected === null) throw refusal('Select a Jubian project before enabling recovery')
      const project = selected !== null && (input.enabled || input.projectDir !== undefined)
        ? await recoveryProject(selected, signal) : undefined
      const decoder = input.enabled ? await this.decoder(signal) : undefined
      if (input.enabled && decoder === undefined) throw refusal('The Host FFmpeg decoder is unavailable')
      const configuration = { enabled: input.enabled, projectDir: project?.directory ?? selected }
      signal.throwIfAborted()
      await writeFileAtomic(this.options.settingsPath, JSON.stringify(configuration) + '\n', { mode: 0o600, dirMode: 0o700 })
      // A completed atomic write stays committed even if its response was cancelled.
      this.configuration = configuration
      await this.stopWorker()
      if (!this.closing && configuration.enabled && project !== undefined && decoder !== undefined) {
        this.startWorker(project.directory, decoder)
      }
      signal.throwIfAborted()
      return this.statusSnapshot(configuration, signal)
    }))
  }

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
      if (previous.digest !== digest || previous.status !== 'awaiting_review') throw refusal('Read the current report before recording a decision')
      signal.throwIfAborted()
      return reportView(await reviewRecoveredVideo(project.directory, input.idempotencyKey, {
        action: input.action, digest, ...(reason === undefined ? {} : { reason }),
      }, signal), input.idempotencyKey)
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
      if (report.digest !== input.digest || sha === undefined) throw refusal('Select an approved video with passing picture and audio checks')
      const existing = await recoverApprovedVideoDelivery(project.directory, report.taskId, report.digest, sha, signal)
      if (existing !== undefined) {
        const current = reportView(
          await reviewRecoveredVideo(project.directory, input.idempotencyKey, undefined, signal), input.idempotencyKey)
        if (current.digest !== report.digest || approvedSourceSha(current) !== sha) throw refusal('The approval changed before delivery')
        return { ...current, directDelivery: existing }
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
    if (this.closing) return Promise.reject(refusal('Video recovery is shutting down'))
    const signal = caller === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, caller])
    const operation = Promise.resolve().then(() => { signal.throwIfAborted(); return action(signal) })
    this.operations.add(operation)
    void operation.then(() => { this.operations.delete(operation) }, (error: unknown) => {
      // An unconfirmed native range remains owned even after its request failed.
      if (!(error instanceof VideoMediaDrainError)) this.operations.delete(operation)
    })
    return operation
  }
}

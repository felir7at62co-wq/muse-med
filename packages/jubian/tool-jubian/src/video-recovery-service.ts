/** Authenticated browser configuration and review for a local Jubian project. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, link, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { JubianClient, JubianLedger, JubianLedgerRecord } from '@deepseek-ai/dsh-jubian'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { verifyApprovedClipExport } from './approved-clip-export.ts'
import { episodeDeliveryReceiptPath, listApprovedEpisodeNumbers, readApprovedEpisodePlan, readEpisodeDelivery,
  parseEpisodeDelivery, summarizeApprovedEpisode } from './episode-delivery.ts'
import { checkVideoMedia, decodeVideoFile } from './video-media-check.ts'
import {
  adoptRecoveredVideo, isProjectVideoIntent, materializeApprovedProviderVideo, publishApprovedVideo,
  readApprovedVideoDelivery, reviewRecoveredVideo, runVideoRecovery, artifactHash,
} from './video-recovery.ts'
import type {
  ApprovedClipDeliveryInput, ApprovedClipDraftService, ApprovedEpisodeDelivery, ApprovedEpisodeDeliverySummary,
  VideoRecoveryAdoptionInput, VideoRecoveryConfigurationInput, VideoRecoveryReview,
  VideoRecoveryReviewInput, VideoRecoveryStatus,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authenticated video recovery configuration and review. */
    jubianVideoRecovery: JubianVideoRecovery
  }
}

/** Trusted Host inputs for the browser recovery service. */
export interface JubianVideoRecoveryOptions {
  /** Ledger used by the Host's paid submission tools. */
  readonly ledger: JubianLedger
  /** Local operator settings document. */
  readonly settingsPath: string
  /** Read-only transport factory scoped to the selected project's credentials. */
  readonly clientForProject: (projectDir: string) => JubianClient
  /** Deployment-selected decoder, never set by a browser request. */
  readonly ffmpegPath: string | undefined
  /** Milliseconds between task reads. */
  readonly intervalMs: number
  /** Milliseconds allowed for each decode. */
  readonly decodeTimeoutMs: number
  /** Existing deployment worker. The browser can review its reports without replacing it. */
  readonly fixed?: { readonly projectDir: string; readonly keys?: readonly string[] }
}

const configurationSchema = z.object({ enabled: z.boolean(), projectDir: z.string().nullable() })
const projectBindingSchema = z.object({
  jubian_script_id: z.union([z.number(), z.string().regex(/^[0-9]+$/)]).transform(Number)
    .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
})
const evidenceSchema = z.object({
  idempotency_key: z.string(),
  task_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['awaiting_review', 'provider_failed']),
  media_checks: z.array(z.object({ sha256: z.string(), video: z.boolean(), audio: z.boolean() })),
})
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const deliverySchema = z.object({
  draft: z.object({ path: z.string(), name: z.string() }),
  export: z.object({
    path: z.string(), sha256: digestSchema, videoSimilarity: z.number().min(0).max(1),
    audioSimilarity: z.number().min(0).max(1),
  }).optional(),
})
const derivativeViewSchema = z.object({ path: z.string(), sha256: digestSchema, video: z.boolean(), audio: z.boolean() })
const reasonSchema = z.string().trim().min(1).max(1000)
const reopenedFromSchema = z.object({ digest: digestSchema, rejectionReason: z.string().nullable(), reason: reasonSchema })
const decisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), digest: digestSchema, reason: z.undefined().optional() }),
  z.object({ action: z.literal('reject'), digest: digestSchema, reason: reasonSchema.optional() }),
])
type Configuration = z.infer<typeof configurationSchema>

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path)
    return entry.isFile() && !entry.isSymbolicLink()
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function readConfiguration(path: string): Promise<Configuration> {
  let entry
  try { entry = await lstat(path) } catch (error) {
    if (isMissing(error)) return { enabled: false, projectDir: null }
    throw error
  }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Jubian video recovery settings must be a regular file')
  const settings = configurationSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  if ((settings.enabled && settings.projectDir === null)
    || (settings.projectDir !== null && !isAbsolute(settings.projectDir))) {
    throw new Error('Jubian video recovery settings require an absolute project directory')
  }
  return settings
}

async function boundProject(path: string): Promise<{ directory: string; scriptId: number }> {
  if (!isAbsolute(path)) throw new Error('Select an absolute Jubian project directory')
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Select a regular Jubian project directory')
  const directory = await realpath(path)
  const config = join(directory, 'project_config.json')
  if (!await regularFile(config)) throw new Error('The selected directory has no regular project_config.json')
  const source = await readFile(config, 'utf8')
  let binding: unknown
  try { binding = JSON.parse(source.replace(/^\uFEFF/, '')) }
  catch (error) { throw new Error('The selected project has an invalid project_config.json', { cause: error }) }
  const checked = projectBindingSchema.safeParse(binding)
  if (!checked.success) throw new Error('The selected project has no valid Jubian script ID')
  return { directory, scriptId: checked.data.jubian_script_id }
}

function refusal(message: string, cause?: unknown): RemoteError {
  return new RemoteError('jubian-video-recovery/rejected', message, {}, { cause })
}

function reportView(report: Awaited<ReturnType<typeof reviewRecoveredVideo>>, key: string): VideoRecoveryReview {
  const evidence = evidenceSchema.parse(report.evidence)
  if (evidence.idempotency_key !== key) throw new Error('Video review report belongs to another submission')
  const digest = digestSchema.parse(report.digest)
  const derivative = report.derivative === null ? null : derivativeViewSchema.parse(report.derivative)
  const decision = report.decision === null ? null : decisionSchema.parse(report.decision)
  const reopenedFrom = reopenedFromSchema.optional().parse(report.reopened_from)
  if (decision !== null && decision.digest !== digest) throw new Error('Video review decision belongs to another report')
  return {
    idempotencyKey: key, taskId: evidence.task_id, status: evidence.status, digest,
    mediaChecks: derivative === null ? evidence.media_checks : [
      { sha256: derivative.sha256, video: derivative.video, audio: derivative.audio },
    ],
    ...(derivative === null ? {} : { derivative: { path: derivative.path, sha256: derivative.sha256 } }),
    decision: decision?.action ?? null,
    ...(decision?.reason === undefined ? {} : { reason: decision.reason }),
    ...(reopenedFrom === undefined ? {} : { reopenedFrom }),
  }
}

function approvedSourceSha(report: VideoRecoveryReview): string | undefined {
  const [check] = report.mediaChecks
  if (report.decision !== 'approve' || report.status !== 'awaiting_review'
    || report.mediaChecks.length !== 1 || !check?.video || !check.audio) return undefined
  if (report.derivative !== undefined) return report.derivative.sha256
  return /^sha256:([a-f0-9]{64})$/.exec(check.sha256)?.[1]
}

function deliveryPath(project: string, report: VideoRecoveryReview): string {
  return join(project, 'video_tasks', 'review', report.digest + '.delivery.json')
}

async function withDelivery(project: string, report: VideoRecoveryReview): Promise<VideoRecoveryReview> {
  const sha256 = approvedSourceSha(report)
  if (sha256 === undefined) return report
  const directDelivery = await readApprovedVideoDelivery(project, report.taskId, report.digest, sha256)
  const current = directDelivery === undefined ? report : { ...report, directDelivery }
  const path = deliveryPath(project, report)
  if (!await regularFile(path)) return current
  const saved: unknown = JSON.parse(await readFile(path, 'utf8'))
  const { draft, export: verified } = deliverySchema.parse(saved)
  return { ...current, delivery: { draft, ...(verified === undefined ? {} : { export: verified }) } }
}

/** Project recovery settings and explicit human decisions over the authenticated Gateway. */
export class JubianVideoRecovery extends TypertRemoteService {
  private readonly state: {
    configuration: Configuration
    worker?: { controller: AbortController; done: Promise<void> }
    closing: boolean
    queue: Promise<void>
  } = { configuration: { enabled: false, projectDir: null }, closing: false, queue: Promise.resolve() }

  /**
   * @param ctx - Host context owning the Remote and recovery worker.
   * @param options - Trusted Host configuration and credential-aware dependencies.
   */
  constructor(ctx: Context, private readonly options: JubianVideoRecoveryOptions) {
    super(ctx, 'jubianVideoRecovery')
    ctx.effect(() => async () => {
      this.state.closing = true
      this.state.worker?.controller.abort()
      await this.state.queue
      await this.stopWorker()
    })
  }

  /** Load the saved local operator choice before the browser can use this Remote. */
  async [Service.init](): Promise<void> {
    const fixed = this.options.fixed
    if (fixed !== undefined) {
      this.state.configuration = { enabled: true, projectDir: resolve(fixed.projectDir) }
      return
    }
    const saved = await readConfiguration(this.options.settingsPath)
    if (this.state.closing) return
    this.state.configuration = saved
    if (saved.enabled && saved.projectDir !== null) {
      try {
        const project = await boundProject(saved.projectDir)
        if (await this.decoderAvailable()) this.startWorker(project.directory)
      } catch (error) {
        this.ctx.logger.warn('Jubian video recovery could not resume the selected project: %s',
          error instanceof Error ? error.message : String(error))
      }
    }
  }

  /**
   * Read the saved switch and reports belonging to the selected project.
   * @returns The current settings and report rows without provider URLs or credentials.
   */
  @Remote
  async status(): Promise<VideoRecoveryStatus> {
    const configuration = this.state.configuration
    return {
      ...configuration,
      configurable: this.options.fixed === undefined,
      decoderAvailable: await this.decoderAvailable(),
      draftAvailable: this.ctx.get('approvedClipDraft') !== undefined,
      automaticExportAvailable: this.ctx.get('approvedClipDraft')?.export !== undefined,
      episodeRendererAvailable: this.ctx.get('approvedEpisodeRenderer') !== undefined,
      reports: await this.reports(configuration.projectDir),
      episodes: configuration.projectDir === null ? [] : await this.episodes(configuration.projectDir),
    }
  }

  /**
   * Save the local operator's choice and switch the background worker.
   * @param input - Switch value and, when changing it, the absolute project directory.
   * @returns The persisted configuration and the newly selected project's reports.
   */
  @Remote
  async configure(input: VideoRecoveryConfigurationInput): Promise<VideoRecoveryStatus> {
    return await this.enqueue(async () => {
      if (this.options.fixed !== undefined) throw refusal('The deployment manages video recovery settings')
      const selected = input.projectDir ?? this.state.configuration.projectDir
      if (input.enabled && selected === null) throw refusal('Select a Jubian project directory before enabling recovery')
      let projectDir = selected
      if (selected !== null && (input.enabled || input.projectDir !== undefined)) {
        try { projectDir = (await boundProject(selected)).directory }
        catch (error) {
          throw refusal('Select an existing Jubian project directory with a valid project_config.json', error)
        }
      }
      if (input.enabled && !await this.decoderAvailable()) throw refusal('The Host FFmpeg decoder is unavailable')
      this.ctx.invocation?.signal.throwIfAborted()
      const configuration = { enabled: input.enabled, projectDir }
      try {
        await writeFileAtomic(this.options.settingsPath, JSON.stringify(configuration) + '\n', { mode: 0o600, dirMode: 0o700 })
      } catch (error) { throw refusal('Could not save video recovery settings', error) }
      await this.stopWorker()
      this.state.configuration = configuration
      if (configuration.enabled && projectDir !== null) this.startWorker(projectDir)
      return await this.status()
    })
  }

  /**
   * Read a report, record a decision, or reopen a rejected artifact for one more review.
   * @param input - Recorded submission key and the exact digest for any change.
   * @returns The current report, its durable decision and any earlier rejection.
   */
  @Remote
  async review(input: VideoRecoveryReviewInput): Promise<VideoRecoveryReview> {
    return await this.enqueue(async () => {
      const selected = this.state.configuration.projectDir
      if (selected === null) throw refusal('Select a Jubian project before reviewing video')
      try {
        const project = await boundProject(selected)
        const key = input.idempotencyKey
        if (!this.ownsRecord(await this.options.ledger.find(key), project)) {
          throw refusal('The submission does not belong to the selected Jubian project')
        }
        const previous = reportView(await reviewRecoveredVideo(project.directory, key), key)
        const reason = reasonSchema.optional().safeParse(input.reason)
        if (!reason.success || (reason.data !== undefined && input.action !== 'reject' && input.action !== 'reopen')
          || (input.action === 'reopen' && reason.data === undefined)) {
          throw refusal('A review reason must contain 1 to 1000 characters')
        }
        if (input.action === 'read') return await withDelivery(project.directory, previous)
        const digest = digestSchema.safeParse(input.digest)
        if (!digest.success) throw refusal('Read the report before recording a decision')
        if (previous.digest !== digest.data || previous.status !== 'awaiting_review') {
          throw refusal('The report changed or is not awaiting review')
        }
        if (input.action === 'reopen' && (previous.decision !== 'reject' || previous.reopenedFrom !== undefined)) {
          throw refusal('Only the original rejected review can be reopened')
        }
        this.ctx.invocation?.signal.throwIfAborted()
        return reportView(await reviewRecoveredVideo(project.directory, key, {
          action: input.action, digest: digest.data,
          ...(reason.data === undefined ? {} : { reason: reason.data }),
        }), key)
      } catch (error) {
        if (error instanceof RemoteError) throw error
        throw refusal('Could not read or record a decision for this video report', error)
      }
    })
  }

  /**
   * Capture and decode one local derivative before making it the review target.
   * @param input - Submission key, current digest and project-relative MP4 path.
   * @returns The active derivative, decoder results and updated review digest.
   */
  @Remote
  async adopt(input: VideoRecoveryAdoptionInput): Promise<VideoRecoveryReview> {
    return await this.enqueue(async () => {
      const selected = this.state.configuration.projectDir
      const ffmpegPath = this.options.ffmpegPath
      if (selected === null) throw refusal('Select a Jubian project before adopting a video')
      if (ffmpegPath === undefined || !await this.decoderAvailable()) throw refusal('Video decoding is unavailable')
      try {
        const project = await boundProject(selected)
        const key = input.idempotencyKey
        if (!this.ownsRecord(await this.options.ledger.find(key), project)) {
          throw refusal('The submission does not belong to the selected Jubian project')
        }
        const signal = this.ctx.invocation?.signal ?? new AbortController().signal
        const digest = digestSchema.parse(input.digest)
        const adopted = await adoptRecoveredVideo(project.directory, key, digest, input.path,
          path => decodeVideoFile(path, ffmpegPath, this.options.decodeTimeoutMs, signal), signal)
        return reportView(adopted, key)
      } catch (error) {
        if (error instanceof RemoteError) throw error
        throw refusal('Could not adopt this project video for review', error)
      }
    })
  }

  /**
   * Publish the exact approved MP4 as a project export without an editor.
   * @param input - Submission key and its approved review digest.
   * @returns The report with the direct delivery receipt.
   */
  @Remote
  async deliverApprovedMp4(input: ApprovedClipDeliveryInput): Promise<VideoRecoveryReview> {
    return await this.enqueue(async () => {
      try {
        const { project, report, source, sha256 } = await this.approvedClip(input)
        const signal = this.ctx.invocation?.signal ?? new AbortController().signal
        const directDelivery = await publishApprovedVideo(project, report.taskId, report.digest, source, sha256, signal)
        return { ...report, directDelivery }
      } catch (error) {
        if (error instanceof RemoteError) throw error
        throw refusal(error instanceof Error ? error.message : 'Could not deliver the approved MP4', error)
      }
    })
  }

  /**
   * Render and verify the selected episode from its exact approved report set.
   * @param input - Episode number and the current authored plan digest.
   * @returns The durable project-relative MP4 receipt.
   */
  @Remote
  async deliverApprovedEpisode(input: { episode: number; digest: string }): Promise<ApprovedEpisodeDeliverySummary> {
    return await this.enqueue(async () => {
      const renderer = this.ctx.get('approvedEpisodeRenderer')
      if (renderer === undefined) throw refusal('Direct episode rendering is unavailable on this Host')
      if (!Number.isSafeInteger(input.episode) || input.episode < 1 || input.episode > 99
        || !digestSchema.safeParse(input.digest).success) {
        throw refusal('Episode delivery requires a numbered episode and a valid plan digest')
      }
      const selected = this.state.configuration.projectDir
      if (selected === null) throw refusal('Select a Jubian project before delivering an episode')
      let unreceiptedOutput: string | undefined
      try {
        const project = await boundProject(selected)
        const summary = (await this.episodes(project.directory)).find(row => row.episode === input.episode)
        if (summary?.readiness !== 'ready' || summary.digest !== input.digest) {
          throw refusal('The episode plan changed or not every listed shot has a passing approval')
        }
        const plan = await readApprovedEpisodePlan(project.directory, input.episode)
        const previous = await readEpisodeDelivery(project.directory, input.episode, input.digest)
        if (previous !== undefined) {
          const path = join(project.directory, previous.path)
          if (await artifactHash(path) !== previous.sha256) throw refusal('The recorded episode output changed after delivery')
          return { ...summary, delivery: previous }
        }
        const reports = await this.reports(project.directory)
        const clips = [] as { shot: number; path: string; sha256: string }[]
        for (const shot of plan.plan.shots) {
          const report = reports.find(row => row.idempotencyKey === shot.idempotency_key)
          if (report === undefined || report.digest !== shot.review_digest) throw refusal('An episode approval changed before rendering')
          const approved = await this.approvedClip({ idempotencyKey: shot.idempotency_key, digest: shot.review_digest })
          clips.push({ shot: shot.shot, path: approved.source, sha256: approved.sha256 })
        }
        const outputPath = join(project.directory, 'exports', `Supermuse-episode-${String(input.episode).padStart(2, '0')}-${input.digest}.mp4`)
        const signal = this.ctx.invocation?.signal ?? new AbortController().signal
        const rendered = await renderer.render({
          projectDir: project.directory, episode: input.episode, clips,
          timelinePath: plan.timelinePath, subtitlePath: plan.subtitlePath, mixProfilePath: plan.mixProfilePath,
          ...(plan.bgmPath === undefined ? {} : { bgmPath: plan.bgmPath }), outputPath,
        }, signal)
        unreceiptedOutput = outputPath
        signal.throwIfAborted()
        const current = (await this.episodes(project.directory)).find(row => row.episode === input.episode)
        if (current?.readiness !== 'ready' || current.digest !== input.digest) {
          throw refusal('The episode approval set changed during rendering')
        }
        const ffmpeg = this.options.ffmpegPath
        if (ffmpeg === undefined) throw refusal('Video decoding is unavailable')
        const decoded = await decodeVideoFile(outputPath, ffmpeg, this.options.decodeTimeoutMs, signal)
        if (!decoded.video || !decoded.audio) throw refusal('The episode MP4 must contain decodable picture and audio')
        const checks = [...rendered.checks]
        if (checks.some(check => !check.ok)) throw refusal('The episode renderer reported a failed check')
        const delivery: ApprovedEpisodeDelivery = {
          path: relative(project.directory, outputPath).split(sep).join('/'),
          sha256: await artifactHash(outputPath, signal),
          durationSeconds: rendered.durationSeconds,
          checks,
        }
        const receiptPath = episodeDeliveryReceiptPath(project.directory, input.episode, input.digest)
        await this.publishEpisodeReceipt(receiptPath, delivery)
        unreceiptedOutput = undefined
        return { ...summary, delivery }
      } catch (error) {
        if (error instanceof RemoteError) throw error
        throw refusal(error instanceof Error ? error.message : 'Could not deliver the approved episode', error)
      } finally {
        if (unreceiptedOutput !== undefined) {
          try { await unlink(unreceiptedOutput) }
          catch (error) {
            if (!isMissing(error)) this.ctx.logger.warn('Unreceipted episode MP4 could not be removed: %s',
              error instanceof Error ? error.message : String(error))
          }
        }
      }
    })
  }

  /**
   * Create the editor draft from the exact approved project artifact.
   * @param input - Submission key and its approved review digest.
   * @returns The report and saved draft identity.
   */
  @Remote
  async createDraft(input: ApprovedClipDeliveryInput): Promise<VideoRecoveryReview> {
    return await this.enqueue(async () => {
      const provider = this.ctx.get('approvedClipDraft')
      if (provider === undefined) throw refusal('Jianying draft creation is unavailable on this Host')
      try {
        return await this.saveDraft(await this.approvedClip(input), provider, this.ctx.invocation?.signal)
      } catch (error) {
        if (error instanceof RemoteError) throw error
        throw refusal(error instanceof Error ? error.message : 'Could not create the Jianying draft', error)
      }
    })
  }

  /**
   * Create or reuse the approved draft, render a new MP4, and verify both tracks.
   * @param input - Submission key and exact approved review digest.
   * @returns The report with the new export and comparison scores.
   */
  @Remote
  async deliverApprovedClip(input: ApprovedClipDeliveryInput): Promise<VideoRecoveryReview> {
    return await this.enqueue(async () => {
      const provider = this.ctx.get('approvedClipDraft')
      const ffmpeg = this.options.ffmpegPath
      if (provider?.export === undefined) throw refusal('Automatic Jianying export is unavailable on this Host')
      if (ffmpeg === undefined || !await this.decoderAvailable()) throw refusal('Video decoding is unavailable')
      try {
        const clip = await this.approvedClip(input)
        const { project, source, sha256 } = clip
        const signal = this.ctx.invocation?.signal ?? new AbortController().signal
        const report = await this.saveDraft(clip, provider, signal, true)
        const draft = report.delivery?.draft
        if (draft === undefined) throw new Error('The approved draft was not saved')
        const directory = join(project, 'exports')
        await mkdir(directory, { recursive: true })
        if (!(await lstat(directory)).isDirectory() || relative(directory, await realpath(directory)) !== '') {
          throw new Error('The project exports directory must be local')
        }
        // Jianying 11.7 accepts at most 50 characters in the export title.
        const path = 'exports/Supermuse-' + String(report.taskId) + '-' + randomUUID().replaceAll('-', '').slice(0, 16) + '.mp4'
        const outputPath = join(project, path)
        signal.throwIfAborted()
        const output = await provider.export({ draftName: draft.name, draftPath: draft.path, outputPath }, signal)
        if (output.path !== outputPath) throw new Error('Jianying returned an unexpected export path')
        return await this.saveVerifiedExport(project, report, source, sha256, path, ffmpeg, signal)
      } catch (error) {
        if (error instanceof RemoteError) throw error
        throw refusal(error instanceof Error ? error.message : 'Could not automatically export the Jianying draft', error)
      }
    })
  }

  /**
   * Verify a local editor export against the artifact reviewed for the draft.
   * @param input - Submission key, approved digest and project-relative export path.
   * @returns The report with the export digest and comparison results.
   */
  @Remote
  async verifyExport(input: VideoRecoveryAdoptionInput): Promise<VideoRecoveryReview> {
    return await this.enqueue(async () => {
      const ffmpeg = this.options.ffmpegPath
      if (ffmpeg === undefined || !await this.decoderAvailable()) throw refusal('Video decoding is unavailable')
      try {
        const { project, report, source, sha256 } = await this.approvedClip(input)
        const signal = this.ctx.invocation?.signal ?? new AbortController().signal
        return await this.saveVerifiedExport(project, report, source, sha256, input.path, ffmpeg, signal)
      } catch (error) {
        if (error instanceof RemoteError) throw error
        throw refusal(error instanceof Error ? error.message : 'Could not verify the Jianying export', error)
      }
    })
  }

  private async saveDraft({ project, report, source, sha256 }: Awaited<ReturnType<JubianVideoRecovery['approvedClip']>>,
    provider: ApprovedClipDraftService, signal?: AbortSignal, recheck = false): Promise<VideoRecoveryReview> {
    if (report.delivery !== undefined && !recheck) return report
    const { path, name } = await provider.create({ projectDir: project, path: source, sha256, taskId: report.taskId }, signal)
    signal?.throwIfAborted()
    if (report.delivery?.draft.path === path && report.delivery.draft.name === name) return report
    const delivery = { draft: { path, name } }
    await writeFileAtomic(deliveryPath(project, report), JSON.stringify(delivery) + '\n', { mode: 0o600 })
    return { ...report, delivery }
  }

  private async saveVerifiedExport(project: string, report: VideoRecoveryReview, source: string, sha256: string,
    path: string, ffmpeg: string, signal: AbortSignal): Promise<VideoRecoveryReview> {
    if (report.delivery === undefined) throw refusal('Create the Jianying draft before verifying its export')
    const verified = await verifyApprovedClipExport(project, source, sha256, path, ffmpeg, this.options.decodeTimeoutMs, signal)
    signal.throwIfAborted()
    const delivery = { ...report.delivery, export: verified }
    await writeFileAtomic(deliveryPath(project, report), JSON.stringify(delivery) + '\n', { mode: 0o600 })
    return { ...report, delivery }
  }

  private async approvedClip(input: ApprovedClipDeliveryInput) {
    const selected = this.state.configuration.projectDir
    if (selected === null) throw refusal('Select a Jubian project before delivering video')
    const project = await boundProject(selected)
    const key = input.idempotencyKey
    if (!this.ownsRecord(await this.options.ledger.find(key), project)) {
      throw refusal('The submission does not belong to the selected Jubian project')
    }
    const report = reportView(await reviewRecoveredVideo(project.directory, key), key)
    const sha256 = approvedSourceSha(report)
    if (report.digest !== input.digest || sha256 === undefined) {
      throw refusal('Select an approved local video with passing picture and audio checks')
    }
    if (report.derivative !== undefined) {
      return {
        project: project.directory, report: await withDelivery(project.directory, report),
        source: join(project.directory, report.derivative.path), sha256,
      }
    }
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    const source = await materializeApprovedProviderVideo(project.directory, report.taskId, sha256,
      () => this.options.clientForProject(project.directory), signal)
    const current = reportView(await reviewRecoveredVideo(project.directory, key), key)
    if (current.digest !== report.digest || approvedSourceSha(current) !== sha256) {
      throw refusal('The video review changed before delivery')
    }
    return { project: project.directory, report: await withDelivery(project.directory, current), source, sha256 }
  }

  private async reports(selected: string | null): Promise<VideoRecoveryReview[]> {
    if (selected === null) return []
    let project: Awaited<ReturnType<typeof boundProject>>
    try { project = await boundProject(selected) }
    catch (error) {
      if (isMissing(error)) return []
      throw refusal('The configured Jubian project cannot be read', error)
    }
    const result: VideoRecoveryReview[] = []
    for (const record of await this.options.ledger.records()) {
      if (!this.ownsRecord(record, project)) continue
      try {
        const report = reportView(await reviewRecoveredVideo(project.directory, record.idempotency_key), record.idempotency_key)
        result.push(await withDelivery(project.directory, report))
      } catch (error) {
        if (!isMissing(error)) throw refusal('A video recovery report could not be read', error)
      }
    }
    return result
  }

  private async episodes(projectDir: string): Promise<ApprovedEpisodeDeliverySummary[]> {
    const reports = await this.reports(projectDir)
    const result: ApprovedEpisodeDeliverySummary[] = []
    for (const episode of await listApprovedEpisodeNumbers(projectDir)) {
      let summary = await summarizeApprovedEpisode(projectDir, episode, reports)
      if (summary.digest !== undefined) {
        const delivery = await readEpisodeDelivery(projectDir, episode, summary.digest)
        if (delivery !== undefined) {
          const path = join(projectDir, delivery.path)
          if (await artifactHash(path) !== delivery.sha256) throw refusal('A recorded episode output changed after delivery')
          summary = { ...summary, delivery }
        }
      }
      result.push(summary)
    }
    return result
  }

  private async publishEpisodeReceipt(path: string, delivery: ApprovedEpisodeDelivery): Promise<void> {
    const directory = dirname(path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const folder = await lstat(directory)
    if (!folder.isDirectory() || folder.isSymbolicLink() || await realpath(directory) !== directory) {
      throw new Error('Episode delivery receipts must stay in the project review directory')
    }
    const temporary = path + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify(delivery, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    try {
      await link(temporary, path)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      const existing = parseEpisodeDelivery(JSON.parse(await readFile(path, 'utf8')))
      if (existing.sha256 !== delivery.sha256 || existing.path !== delivery.path) {
        throw new Error('A different episode delivery receipt already exists')
      }
    } finally {
      await unlink(temporary)
    }
  }

  private ownsRecord(record: JubianLedgerRecord | undefined, project: { directory: string; scriptId: number }): boolean {
    if (record?.script_id !== project.scriptId || !isProjectVideoIntent(record, project.directory)) return false
    const keys = this.options.fixed?.keys
    return keys === undefined || keys.includes(record.idempotency_key)
  }

  private async decoderAvailable(): Promise<boolean> {
    const path = this.options.ffmpegPath
    return path !== undefined && isAbsolute(path) && await regularFile(path)
  }

  private startWorker(projectDir: string): void {
    const ffmpegPath = this.options.ffmpegPath
    if (this.state.closing || ffmpegPath === undefined) return
    const controller = new AbortController()
    const done = runVideoRecovery(this.options.clientForProject(projectDir), this.options.ledger, projectDir,
      undefined, this.options.intervalMs, controller.signal,
      () => { this.ctx.logger.warn('Jubian video recovery check failed; retrying') },
      (url, signal) => checkVideoMedia(url, ffmpegPath, this.options.decodeTimeoutMs, signal))
      .catch((error: unknown) => {
        this.ctx.logger.warn('Jubian video recovery worker stopped: %s', error instanceof Error ? error.message : String(error))
      })
    this.state.worker = { controller, done }
  }

  private async stopWorker(): Promise<void> {
    const worker = this.state.worker
    if (worker === undefined) return
    worker.controller.abort()
    await worker.done
    delete this.state.worker
  }

  private async enqueue<Result>(action: () => Promise<Result>): Promise<Result> {
    const next = this.state.queue.then(async () => {
      if (this.state.closing) throw refusal('The Host is shutting down')
      return await action()
    })
    this.state.queue = next.then(() => {}, () => {})
    return await next
  }
}

/** Instance-bound configured episode renderer with immutable staging and a separate guardian. */
import type { Context } from '@deepseek-ai/cordis'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { createHash, randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveSettings, stagedEpisodeEndingAssets, preparedSubtitleClockInputs, captureEpisodeSourceReview } from '@deepseek-ai/dsh-tool-episode-render'
import type { Config as RendererConfig } from '@deepseek-ai/dsh-tool-episode-render'
import { executionIdentitySchema, readEpisodeRecord } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'
import type { ApprovedEpisodeCaptureInput, ApprovedEpisodeRenderer, ApprovedEpisodeRendererCapture, ApprovedEpisodeRenderInput,
  ApprovedEpisodeRuntimeInput, EpisodeRendererGeneration, EpisodeRenderResult } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'
import { captureDesktopCarrier, launchGuardian } from './episode-guardian-launcher.ts'
import type { CapturedDesktopCarrier, SourceDshFixture } from './episode-guardian-launcher.ts'
import { createGuardianJournal, guardianParsers } from './episode-guardian-journal.ts'
import { captureEpisodeDirectory, inspectEpisodeFile, stageEpisodeFile } from './episode-render-inputs.ts'
import type { EpisodeFileFact } from './episode-render-inputs.ts'
import type { EpisodeSourceAuthorityFactory, EpisodeSourceQaAuthority } from './episode-source-authority-types.ts'
import { createEpisodeSourceAuthorityResolver } from './episode-source-authority.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { episodeCandidateSchema, episodeConfigurationSchema, episodeDescriptorSchema, episodeFactsHash,
  insideEpisodeRoot, parseEpisodeRendererConfig, readEpisodeDescriptor, readEpisodeDescriptorV3, episodeClockInputsSchema, episodeDescriptorV3Schema, episodeSourceEvidenceSchema, episodeDescriptorV4Schema, readEpisodeDescriptorV4 } from './episode-render-descriptor.ts'

/** Provider resource limits, independently validated by the standalone worker. */
export interface EpisodeRendererLimits {
  readonly requestBytes: number
  readonly replyBytes: number
  readonly descriptorBytes: number
  readonly journalBytes: number
  readonly lockWaitMs: number
  readonly mediaGraceMs: number
  readonly mediaStdoutBytes: number
  readonly mediaStderrBytes: number
  readonly diagnosticBytes: number
  readonly runtimeEntries: number
}

/** Trusted Host inputs; source launch is explicit and available only to owned tests. */
export interface EpisodeRendererOptions {
  readonly carrier: CapturedDesktopCarrier | SourceDshFixture
  readonly rendererConfig: RendererConfig
  readonly codeFiles: readonly string[]
  readonly endingAssetRoot: string
  readonly limits: EpisodeRendererLimits
  readonly resolveExecutable: (command: string) => Promise<string>
  /** Reject replacement of the actual preset declaration used at provider activation. */
  readonly verifyConfiguration: () => Promise<void>
  /** Live Host-owned Session and workspace verifier for strict source review. */
  readonly sourceAuthority?: EpisodeSourceAuthorityFactory
}

/** Configured media owner whose lifetime is independent of each admission request. */
export class ConfiguredEpisodeRenderer implements ApprovedEpisodeRenderer {
  private readonly lifetime = new AbortController()
  private readonly generation = brandString<EpisodeRendererGeneration>(randomUUID())
  private readonly pending = new Set<Promise<unknown>>()
  private readonly rawChildren = new Set<ChildProcessWithoutNullStreams>()
  private readonly config: RendererConfig
  private closing = false
  private disposal: Promise<void> | undefined

  /**
   * @param options - Trusted carrier, immutable resolved deployment config and limits.
   * @param code - Exact loaded owner-module facts captured before publishing this provider.
   */
  constructor(private readonly options: EpisodeRendererOptions, private readonly code: readonly EpisodeFileFact[]) {
    this.config = structuredClone(parseEpisodeRendererConfig(options.rendererConfig))
  }

  private own<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (this.closing) return Promise.reject(new Error('Episode renderer provider is closing'))
    const task = Promise.resolve().then(operation)
    this.pending.add(task)
    void task.then(() => { this.pending.delete(task) }, () => { this.pending.delete(task) })
    return task
  }

  /** @inheritdoc */
  capture(input: ApprovedEpisodeCaptureInput, signal: AbortSignal): Promise<ApprovedEpisodeRendererCapture> {
    const captured = structuredClone(input), config = structuredClone(this.config)
    const generation = this.generation, lifetime = this.lifetime.signal
    return this.own(async () => {
      const active = AbortSignal.any([signal, lifetime]); active.throwIfAborted()
      await this.options.verifyConfiguration()
      if (await realpath(captured.projectDir) !== captured.projectDir) throw new Error('Episode project must be canonical')
      const clockInputs = await capturePreparedInputs(captured, config, active)
      const sourceEvidence = await this.captureSourceEvidence(captured, config, clockInputs, active)
      for (const file of [...captured.inputHashes, ...this.code]) await exactFile(file, active)
      const resolved = resolveSettings(config)
      const [ffmpeg, ffprobe, fontsDir] = await Promise.all([
        this.options.resolveExecutable(resolved.ffmpeg).then(path => realpath(path)),
        this.options.resolveExecutable(resolved.ffprobe).then(path => realpath(path)), realpath(resolved.fontsDir),
      ])
      const [encoder, probe, fonts] = await Promise.all([inspectEpisodeFile(ffmpeg, active), inspectEpisodeFile(ffprobe, active),
        captureEpisodeDirectory(fontsDir, this.options.limits.runtimeEntries, active)])
      const normalized = structuredClone(config)
      normalized.ffmpegPath = ffmpeg; normalized.ffprobePath = ffprobe; normalized.fontsDir = fontsDir
      const ending = await stagedEpisodeEndingAssets({ project: captured.projectDir, timelinePath: captured.timelinePath },
        resolveSettings(normalized))
      const endings = ending === undefined ? [] : await Promise.all([ending.audio, ending.effect]
        .map(async (asset) => {
          const fact = await inspectEpisodeFile(await realpath(join(this.options.endingAssetRoot, asset.file)), active)
          if (fact.sha256 !== asset.sha256) throw new Error('Bundled episode ending asset changed')
          return fact
        }))
      const runtimeInputs: ApprovedEpisodeRuntimeInput[] = [
        ...this.code.map(file => ({ ...file, owner: 'renderer' as const })),
        ...[encoder, probe, ...endings].map(file => ({ ...file, owner: 'media' as const })),
        ...fonts.map(file => ({ ...file, owner: 'font' as const })),
      ]
      const configuration = episodeConfigurationSchema.parse({ projectDir: captured.projectDir, episode: captured.episode,
        digest: captured.digest, config: normalized, runtimeInputs,
        projectInputs: captured.inputHashes.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) })
      const identity = { generation, configurationSha256: episodeFactsHash(sourceEvidence !== undefined
        ? { configuration, clockInputs, sourceEvidence } : clockInputs === undefined ? configuration : { configuration, clockInputs }),
      codeSha256: episodeFactsHash(runtimeInputs.filter(file => file.owner === 'renderer')) }
      active.throwIfAborted()
      return { identity, runtimeInputs, signal: lifetime,
        revalidate: validationSignal => this.own(async () => {
          const active = AbortSignal.any([validationSignal, lifetime]); active.throwIfAborted()
          await this.options.verifyConfiguration()
          const current = await capturePreparedInputs(captured, config, active)
          if (episodeFactsHash(current ?? null) !== episodeFactsHash(clockInputs ?? null)) {
            throw new Error('字幕来源时钟或绑定素材发生变化，请重新核对。')
          }
          for (const file of [...captured.inputHashes, ...runtimeInputs]) await exactFile(file, active)
        }),
        ...(sourceEvidence === undefined ? {} : { withPublication: <T>(
          publicationSignal: AbortSignal, publish: (signal: AbortSignal) => Promise<T>) => this.own(async () =>
          await this.withSourcePublication(captured, config, clockInputs, sourceEvidence,
            AbortSignal.any([publicationSignal, lifetime]), publish)) }),
        render: (execution, request) => this.own(async () => await this.renderCaptured(captured, configuration, identity,
          endings, execution, request, clockInputs, sourceEvidence)) }

    })
  }

  private async captureSourceEvidence(input: ApprovedEpisodeCaptureInput, config: RendererConfig,
    clockInputs: z.infer<typeof episodeClockInputsSchema> | undefined, signal: AbortSignal,
    held?: ReadonlyMap<string, EpisodeSourceQaAuthority>): Promise<z.infer<typeof episodeSourceEvidenceSchema> | undefined> {
    const sessions = new Map<string, EpisodeSourceQaAuthority['binding']>()
    const review = await captureEpisodeSourceReview(input.projectDir, String(input.episode).padStart(2, '0'), input.timelinePath,
      resolveSettings(config), async (binding) => {
        const factory = this.options.sourceAuthority
        if (factory === undefined) throw new Error('Strict source review requires the original native Session authority')
        const existing = held?.get(binding.sessionId)
        const authority = existing ?? await factory(SessionId(binding.sessionId), input.projectDir, signal)
        try {
          if (authority.sessionId !== binding.sessionId) throw new Error('Source review Session does not match its authority')
          authority.assertCurrent()
          await authority.verify(binding, AbortSignal.any([signal, authority.signal]))
          authority.assertCurrent()
          const prior = sessions.get(binding.sessionId)
          if (prior !== undefined && episodeFactsHash(prior) !== episodeFactsHash(authority.binding)) {
            throw new Error('Source review Session binding changed during capture')
          }
          sessions.set(binding.sessionId, authority.binding)
        } finally { if (existing === undefined) authority.release() }
      })
    if (review === undefined) return undefined
    if (clockInputs === undefined) throw new Error('Strict source review requires captured prepared episode inputs')
    const sessionArtifacts = new Set(review.bindings.flatMap(binding => [binding.ocrPath, binding.inspectionPath]))
    const sources = new Map<string, { path: string; sha256: string; bytes: number }>()
    for (const evidence of review.files) {
      const canonical = await realpath(evidence.path)
      if (canonical !== evidence.path || (!insideEpisodeRoot(input.projectDir, canonical) && !sessionArtifacts.has(canonical))) {
        throw new Error('Source evidence must be a canonical project file or verified Session artifact')
      }
      const fact = await inspectEpisodeFile(canonical, signal)
      if (fact.sha256 !== evidence.sha256) throw new Error('Source review evidence changed during capture')
      sources.set(fact.path, fact)
    }
    for (const fact of [clockInputs.manifest, ...(clockInputs.clock === undefined ? [] : [clockInputs.clock]),
      ...(clockInputs.master === undefined ? [] : [clockInputs.master]), ...clockInputs.shots.map(shot => shot.audio)]) {
      const prior = sources.get(fact.path)
      if (prior !== undefined && (prior.sha256 !== fact.sha256 || prior.bytes !== fact.bytes)) throw new Error('Source evidence has conflicting bytes')
      sources.set(fact.path, fact)
    }
    const directory = join(input.projectDir, 'reviews')
    const entries = (await readdir(directory)).sort()
    const reviewPattern = new RegExp(`^ep${String(input.episode).padStart(2, '0')}-p\\d{2,}\\.json$`, 'u')
    for (const name of entries.filter(value => reviewPattern.test(value))) {
      const original = join(directory, name)
      if (await realpath(original) !== original) throw new Error('Source review record must be canonical')
      const fact = await inspectEpisodeFile(original, signal)
      const prior = sources.get(fact.path)
      if (prior !== undefined && (prior.sha256 !== fact.sha256 || prior.bytes !== fact.bytes)) throw new Error('Source review changed during capture')
      sources.set(fact.path, fact)
    }
    return episodeSourceEvidenceSchema.parse({ sessions: [...sessions.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
      sourceQaSha256: review.sourceQaSha256, selectedPaths: review.selectedPaths,
      files: [...sources.values()].sort((a, b) => a.path.localeCompare(b.path)),
      directories: [{ originalPath: directory, entries }], bindings: review.bindings })
  }

  private async withSourcePublication<T>(input: ApprovedEpisodeCaptureInput, config: RendererConfig,
    clockInputs: z.infer<typeof episodeClockInputsSchema> | undefined, evidence: z.infer<typeof episodeSourceEvidenceSchema>,
    signal: AbortSignal, publish: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const factory = this.options.sourceAuthority
    if (factory === undefined) throw new Error('Strict source review requires the original native Session authority')
    const held = new Map<string, EpisodeSourceQaAuthority>()
    try {
      for (const binding of evidence.sessions) {
        const authority = await factory(binding.sessionId, input.projectDir, signal, binding)
        held.set(binding.sessionId, authority)
      }
      const run = async (index: number, active: AbortSignal): Promise<T> => {
        const binding = evidence.sessions[index]
        if (binding !== undefined) {
          const authority = held.get(binding.sessionId)
          if (authority === undefined) throw new Error('Source review authority disappeared')
          return await authority.withPublication(next => run(index + 1, AbortSignal.any([active, next])))
        }
        const currentClock = await capturePreparedInputs(input, config, active)
        if (episodeFactsHash(currentClock ?? null) !== episodeFactsHash(clockInputs ?? null)) {
          throw new Error('字幕来源时钟或绑定素材发生变化，请重新核对。')
        }
        for (const file of input.inputHashes) await exactFile(file, active)
        const current = await this.captureSourceEvidence(input, config, clockInputs, active, held)
        if (episodeFactsHash(current ?? null) !== episodeFactsHash(evidence)) throw new Error('Strict source evidence changed before publication')
        return await publish(active)
      }
      return await run(0, signal)
    } finally { for (const authority of [...held.values()].reverse()) authority.release() }
  }

  private async renderCaptured(capture: ApprovedEpisodeCaptureInput,
    configuration: z.infer<typeof episodeConfigurationSchema>, renderer: ApprovedEpisodeRendererCapture['identity'],
    endings: readonly EpisodeFileFact[], input: ApprovedEpisodeRenderInput, signal: AbortSignal,
    clockInputs: z.infer<typeof episodeClockInputsSchema> | undefined,
    sourceEvidence: z.infer<typeof episodeSourceEvidenceSchema> | undefined): Promise<EpisodeRenderResult> {
    signal.throwIfAborted()
    if (this.closing) throw new Error('Episode renderer provider is closing before execution')
    if (input.identity.configurationSha256 !== renderer.configurationSha256 || !insideEpisodeRoot(input.job.attemptRoot, input.stageRoot)
      || await realpath(input.stageRoot) !== input.stageRoot) throw new Error('Episode execution does not match its captured renderer')
    if (input.sources.length === 0 || input.sources.some((source, index) => source.shot !== index + 1)
      || new Set(input.sources.map(source => source.idempotencyKey)).size !== input.sources.length) throw new Error('Episode sources must retain contiguous approved shot order')
    await this.options.verifyConfiguration()
    const currentClock = await capturePreparedInputs(capture, configuration.config, signal)
    if (episodeFactsHash(currentClock ?? null) !== episodeFactsHash(clockInputs ?? null)) throw new Error('字幕来源时钟或绑定素材发生变化，请重新核对。')
    for (const file of [...capture.inputHashes, ...configuration.runtimeInputs, ...input.sources]) await exactFile(file, signal)
    const logicalRoot = join(input.job.attemptRoot, 'inputs')
    await mkdir(logicalRoot, { recursive: true, mode: 0o700 })
    const episode = String(capture.episode).padStart(2, '0')
    const selected = capture.inputHashes.map(file => ({ source: file,
      relative: inputRelativePath(file.role, file.path, capture.projectDir) }))
    const sources = input.sources.map(source => ({ source,
      relative: join('video', episode, `shot_${String(source.shot).padStart(3, '0')}.mp4`) }))
    const fontsDir = resolveSettings(configuration.config).fontsDir
    const fonts = configuration.runtimeInputs.filter(file => file.owner === 'font').map((file) => {
      if (!insideEpisodeRoot(fontsDir, file.path)) throw new Error('Episode font escaped its captured runtime owner')
      return { source: file, relative: join('__runtime', 'fonts', relative(fontsDir, file.path)) }
    })
    const endingRows = endings.map(file => ({ source: file, relative: join('__runtime', 'ending', basename(file.path)) }))
    if (clockInputs !== undefined && (clockInputs.shots.length !== input.sources.length
      || clockInputs.shots.some((shot, index) => shot.shot !== input.sources[index]?.shot
        || shot.video.sha256 !== input.sources[index].sha256 || shot.video.bytes !== input.sources[index].bytes))) {
      throw new Error('字幕来源视频与已批准的视频不一致，请重新核对。')
    }
    const clockRows = clockInputs === undefined ? [] : [
      ...(clockInputs.clock === undefined ? [] : [{ source: clockInputs.clock,
        relative: `${inputRelativePath('subtitle', capture.subtitlePath, capture.projectDir)}.clock.json` }]),
      { source: clockInputs.manifest, relative: join('editing', `${episode}-sources.json`) },
      ...(clockInputs.master === undefined ? [] : [{ source: clockInputs.master, relative: join('audio', `${episode}.wav`) }]),
      ...clockInputs.shots.map(shot => ({ source: shot.audio, relative: join('__clock', `audio-${shot.shot}${extname(shot.audio.path)}`) })),
    ]
    const extraSourceRows = sourceEvidence === undefined ? [] : sourceEvidence.files.flatMap((file, index) => {
      const videoIndex = sourceEvidence.selectedPaths.indexOf(file.path)
      if (videoIndex >= 0) {
        const approved = input.sources[videoIndex]
        if (approved === undefined || approved.sha256 !== file.sha256 || approved.bytes !== file.bytes) {
          throw new Error('Reviewed source differs from approved video')
        }
        return []
      }
      if (clockInputs !== undefined && (file.path === clockInputs.manifest.path || file.path === clockInputs.clock?.path
        || file.path === clockInputs.master?.path || clockInputs.shots.some(shot => shot.audio.path === file.path))) return []
      return [{ source: file, relative: join('__source-qa', `${index}${extname(file.path)}`) }]
    })
    const rows = [...selected, ...sources, ...fonts, ...endingRows, ...clockRows, ...extraSourceRows]
    if (new Set(rows.map(row => row.relative)).size !== rows.length) throw new Error('Episode stage inputs have colliding paths')
    const locked: { relative: string; file: EpisodeFileFact }[] = []
    for (const row of rows) {
      const target = join(logicalRoot, row.relative)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      locked.push({ relative: row.relative, file: await copyOrReconcile(row.source, target, signal) })
    }
    await input.job.admit({ approvals: input.sources.map(({ idempotencyKey, digest, sha256 }) => ({ idempotencyKey, digest, sha256 })),
      inputs: locked.map(row => row.file) })
    const staged: EpisodeFileFact[] = []
    for (const row of locked) {
      const target = join(input.stageRoot, row.relative)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      staged.push(await stageEpisodeFile(row.file, target, signal))
    }
    const byOriginal = (path: string): string => {
      const row = selected.find(row => row.source.path === path)
      if (row === undefined) throw new Error('Episode path has no captured project input')
      return join(input.stageRoot, row.relative)
    }
    const descriptorPath = join(input.stageRoot, 'descriptor.json'), candidatePath = join(input.stageRoot, 'exports', `${episode}.mp4`)
    await mkdir(dirname(candidatePath), { recursive: true, mode: 0o700 })
    const stagedConfig = structuredClone(configuration.config)
    stagedConfig.fontsDir = join(input.stageRoot, '__runtime', 'fonts')
    const [endingAudio, endingEffect] = endingRows
    if (endingRows.length !== 0 && (endingAudio === undefined || endingEffect === undefined)) {
      throw new Error('Captured episode ending requires both audio and effect')
    }
    const descriptorBase = { kind: 'approved-episode-render', identity: input.identity,
      execution: input.execution, renderer, originalProject: capture.projectDir,
      attemptRoot: input.job.attemptRoot, stageRoot: input.stageRoot,
      configuration, config: stagedConfig, stagedFiles: staged,
      projectFiles: selected.map(row => ({ ...row.source, originalPath: row.source.path, path: join(input.stageRoot, row.relative) })),
      stagedSources: sources.map(row => ({ ...row.source, path: join(input.stageRoot, row.relative) })),
      timelinePath: byOriginal(capture.timelinePath), subtitlePath: byOriginal(capture.subtitlePath),
      mixProfilePath: byOriginal(capture.mixProfilePath),
      ...(capture.bgmPath === undefined ? {} : { bgmPath: byOriginal(capture.bgmPath) }),
      ...(endingAudio === undefined || endingEffect === undefined ? {} : { endingAudio: join(input.stageRoot, endingAudio.relative),
        endingEffect: join(input.stageRoot, endingEffect.relative) }),
      candidatePath, candidateFactsPath: join(input.stageRoot, 'candidate-facts.json'), lastShot: input.sources.length, retry: input.retry }
    const clockStage = clockInputs === undefined ? undefined : {
      ...(clockInputs.clock === undefined ? {} : { clockPath: `${byOriginal(capture.subtitlePath)}.clock.json` }),
      manifestPath: join(input.stageRoot, 'editing', `${episode}-sources.json`),
      ...(clockInputs.master === undefined ? {} : { masterPath: join(input.stageRoot, 'audio', `${episode}.wav`) }),
      audio: clockInputs.shots.map(shot => ({ shot: shot.shot, originalPath: shot.audio.path,
        stagedPath: join(input.stageRoot, '__clock', `audio-${shot.shot}${extname(shot.audio.path)}`) })),
    }
    let sourceClaim: z.infer<typeof episodeDescriptorV4Schema>['sourceClaim'] | undefined
    if (sourceEvidence !== undefined) {
      if (clockInputs === undefined || clockStage === undefined) throw new Error('Strict source inputs are missing')
      const first = sourceEvidence.sessions[0]
      if (first === undefined) throw new Error('Strict source has no Session authority')
      const qaFiles = sourceEvidence.files.map((file) => {
        const selectedIndex = sourceEvidence.selectedPaths.indexOf(file.path)
        const audioIndex = clockInputs.shots.findIndex(shot => shot.audio.path === file.path)
        const extra = extraSourceRows.find(row => row.source.path === file.path)
        const stagedPath = selectedIndex >= 0 ? join(input.stageRoot, sources[selectedIndex]?.relative ?? '')
          : file.path === clockInputs.manifest.path ? clockStage.manifestPath
            : file.path === clockInputs.clock?.path ? clockStage.clockPath
              : file.path === clockInputs.master?.path ? clockStage.masterPath
                : audioIndex >= 0 ? clockStage.audio[audioIndex]?.stagedPath
                  : extra === undefined ? undefined : join(input.stageRoot, extra.relative)
        if (stagedPath === undefined || stagedPath === input.stageRoot) throw new Error('Source evidence has no private stage mapping')
        const roles: z.infer<typeof episodeDescriptorV4Schema>['sourceClaim']['files'][number]['roles'] = []
        if (selectedIndex >= 0) roles.push('selected-video')
        if (audioIndex >= 0 || sourceEvidence.bindings.some(binding => binding.mediaPath === file.path && selectedIndex < 0)) roles.push('source-audio')
        if (file.path === clockInputs.manifest.path) roles.push('source-manifest')
        if (file.path === clockInputs.clock?.path) roles.push('subtitle-clock')
        if (file.path === clockInputs.master?.path) roles.push('master-audio')
        if (sourceEvidence.bindings.some(binding => binding.ocrPath === file.path)) roles.push('ocr')
        if (sourceEvidence.bindings.some(binding => binding.inspectionPath === file.path)) roles.push('inspection')
        if (file.path.startsWith(join(capture.projectDir, 'reviews') + sep)) roles.push('review-record')
        if (file.path === join(capture.projectDir, 'episode_packages', episode, 'package.json')) roles.push('package-record')
        if (roles.length === 0) roles.push('review-evidence')
        return { originalPath: file.path, stagedPath, sha256: file.sha256, bytes: file.bytes, roles }
      })
      sourceClaim = { identity: input.identity, execution: input.execution, sessionId: first.sessionId,
        workspaceRoot: first.workspacePath, workspaceId: first.workspaceId,
        subtitleClock: clockInputs.clock === undefined ? 'absent' : 'present', files: qaFiles,
        directories: sourceEvidence.directories, bindings: sourceEvidence.bindings.map(binding => ({
          mediaOriginalPath: binding.mediaPath, ocrOriginalPath: binding.ocrPath,
          inspectionOriginalPath: binding.inspectionPath, reviewId: binding.reviewId })) }
    }
    const descriptor = sourceEvidence !== undefined && sourceClaim !== undefined && clockInputs !== undefined && clockStage !== undefined
      ? episodeDescriptorV4Schema.parse({ ...descriptorBase, version: 4, clockInputs, clockStage, sourceEvidence, sourceClaim })
      : clockInputs === undefined ? episodeDescriptorSchema.parse({ ...descriptorBase, version: 1 })
        : episodeDescriptorV3Schema.parse({ ...descriptorBase, version: 3, clockInputs, clockStage })
    const bytes = Buffer.from(JSON.stringify(descriptor) + '\n')
    if (bytes.length > this.options.limits.descriptorBytes) throw new Error('Episode descriptor exceeds its configured byte budget')
    await writeFile(descriptorPath, bytes, { flag: 'wx', mode: 0o600 })
    const identity = executionIdentitySchema.parse({ ...input.identity, execution: input.execution,
      descriptorSha256: createHash('sha256').update(bytes).digest('hex') })
    await input.job.admitExecution({ identity, descriptorPath, candidatePath, retry: input.retry })
    signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    const guardian = await launchGuardian({ carrier: this.options.carrier, executionRoot: input.stageRoot,
      descriptorPath, identity, limits: this.options.limits, workerConfig: { ...this.options.limits },
      parsers: guardianParsers, rawChildren: this.rawChildren })
    const cancel = (): void => { guardian.stop() }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    let reply: Awaited<typeof guardian.result> | undefined
    try {
      const observed = await Promise.allSettled([guardian.result, guardian.closed])
      if (observed[0].status === 'fulfilled') reply = observed[0].value
    } finally { signal.removeEventListener('abort', cancel) }
    const journal = createGuardianJournal({ attemptRoot: input.job.attemptRoot, recordBytes: this.options.limits.journalBytes,
      assertAdmission: value => input.job.assertAdmission(value), armExecution: record => input.job.armExecution(record) })
    const proof = await journal.readDrain(identity.execution)
    if (proof !== undefined) {
      for (const key of ['attempt', 'execution', 'rendererGeneration', 'configurationSha256', 'planSha256', 'projectSha256', 'descriptorSha256'] as const) {
        if (proof.identity[key] !== identity[key]) throw new Error('Episode drain differs from its admitted physical execution')
      }
      if (proof.guardianPid !== guardian.pid) throw new Error('Episode drain names another physical guardian PID')
    }
    const result = proof === undefined ? reply?.result : { kind: 'drained' as const, proof }
    if (result === undefined) {
      const previous = await journal.readRunning()
      if (previous === undefined) throw new Error('Episode guardian failed before execution: ' + guardian.diagnostic())
      return { kind: 'unknown', previous, diagnostic: guardian.diagnostic() || 'Guardian exited without matching drain evidence' }
    }
    if (result.kind === 'unknown' || result.kind === 'retry-required') return result
    if (result.proof.result === 'failed') throw new Error('Episode renderer failed after media drain: ' + guardian.diagnostic())
    if (result.proof.result !== 'completed') return { kind: result.kind, proof: result.proof }
    const completed = result.proof
    const admitted = await input.job.readExecution(completed.identity.execution)
    if (admitted === undefined) throw new Error('Completed episode execution has no admitted descriptor')
    const completedDescriptor = sourceEvidence !== undefined
      ? await readEpisodeDescriptorV4(admitted.descriptorPath, completed.identity.descriptorSha256, this.options.limits.descriptorBytes)
      : clockInputs === undefined
        ? await readEpisodeDescriptor(admitted.descriptorPath, completed.identity.descriptorSha256, this.options.limits.descriptorBytes)
        : await readEpisodeDescriptorV3(admitted.descriptorPath, completed.identity.descriptorSha256, this.options.limits.descriptorBytes)
    if (completedDescriptor.candidatePath !== admitted.candidatePath
      || completedDescriptor.identity.attempt !== input.identity.attempt) throw new Error('Completed episode candidate was retargeted')
    const value = await readEpisodeRecord(completedDescriptor.candidateFactsPath, this.options.limits.journalBytes)
    const candidate = episodeCandidateSchema.parse(value)
    if (candidate.path !== admitted.candidatePath) throw new Error('Episode candidate facts name another file')
    await exactFile(candidate, this.lifetime.signal)
    if (candidate.sha256 !== completed.candidate.outputSha256 || candidate.bytes !== completed.candidate.outputBytes) {
      throw new Error('Episode candidate differs from its completed drain proof')
    }
    return { kind: result.kind, proof: completed, candidate }
  }

  /**
   * Close admission synchronously, cancel owned work and join every child observation.
   * @returns When all captures/renders and raw children have settled.
   */
  dispose(): Promise<void> {
    this.closing = true; this.lifetime.abort(new Error('provider-disposed'))
    return this.disposal ??= (async () => {
      await Promise.allSettled(this.pending)
      for (const child of this.rawChildren) child.stdin.end()
      await Promise.all([...this.rawChildren].map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
        : new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })))
    })()
  }
}

async function capturePreparedInputs(input: ApprovedEpisodeCaptureInput, config: RendererConfig,
  signal: AbortSignal): Promise<z.infer<typeof episodeClockInputsSchema> | undefined> {
  signal.throwIfAborted()
  const path = `${input.subtitlePath}.clock.json`
  let hasClock = true
  try { await lstat(path) }
  catch (error) {
    signal.throwIfAborted()
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    hasClock = false
  }
  if (!hasClock) {
    const manifest = join(input.projectDir, 'editing', `${String(input.episode).padStart(2, '0')}-sources.json`)
    try { await lstat(manifest) }
    catch (error) {
      signal.throwIfAborted()
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  const info = await preparedSubtitleClockInputs(input.projectDir, String(input.episode).padStart(2, '0'),
    input.timelinePath, input.subtitlePath, config.enforceSubtitleVisual, signal)
  const capture = async (file: string): Promise<EpisodeFileFact> => {
    signal.throwIfAborted()
    const canonical = await realpath(file)
    if (canonical !== file || !insideEpisodeRoot(input.projectDir, canonical)) throw new Error('字幕来源文件必须是当前项目内的规范路径。')
    return await inspectEpisodeFile(canonical, signal)
  }
  const [clock, manifest, master] = await Promise.all([
    hasClock ? capture(info.clockPath) : undefined, capture(info.manifestPath),
    info.masterPath === undefined ? undefined : capture(info.masterPath),
  ])
  if (info.clockPresent !== hasClock || manifest.sha256 !== info.manifestSha256 || manifest.bytes !== info.manifestBytes) {
    throw new Error('字幕来源清单在读取时发生变化，请重新核对。')
  }
  const shots = await Promise.all(info.shots.map(async ({ shot, video, audio }) => ({ shot,
    video: await capture(video), audio: await capture(audio) })))
  // Read and validate the same evidence a second time after the stable file facts were captured.
  const verified = await preparedSubtitleClockInputs(input.projectDir, String(input.episode).padStart(2, '0'),
    input.timelinePath, input.subtitlePath, config.enforceSubtitleVisual, signal)
  if (episodeFactsHash(verified) !== episodeFactsHash(info)) throw new Error('字幕来源清单或素材在读取时发生变化，请重新核对。')
  const capturedFiles = [...(clock === undefined ? [] : [clock]), manifest, ...(master === undefined ? [] : [master]),
    ...shots.flatMap(shot => [shot.video, shot.audio])]
  for (const file of capturedFiles) {
    await exactFile(file, signal)
  }
  return episodeClockInputsSchema.parse({ ...(clock === undefined ? {} : { clock }), manifest,
    ...(master === undefined ? {} : { master }), shots })
}

async function exactFile(file: EpisodeFileFact, signal: AbortSignal): Promise<void> {
  const actual = await inspectEpisodeFile(file.path, signal)
  if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new Error('Episode captured file changed')
}

async function copyOrReconcile(source: EpisodeFileFact, target: string, signal: AbortSignal): Promise<EpisodeFileFact> {
  let exists = true
  try { await lstat(target) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') exists = false
    else throw error
  }
  if (!exists) return await stageEpisodeFile(source, target, signal)
  const actual = await inspectEpisodeFile(target, signal)
  if (actual.sha256 !== source.sha256 || actual.bytes !== source.bytes) throw new Error('Episode locked stage destination is occupied by different bytes')
  return actual
}

function inputRelativePath(role: ApprovedEpisodeCaptureInput['inputHashes'][number]['role'], path: string, projectDir: string): string {
  if (!insideEpisodeRoot(projectDir, path)) throw new Error('Episode authored input escaped the captured project')
  const name = relative(projectDir, path)
  if (role === 'project' && name !== 'project_config.json' && name !== 'video-bans.json') throw new Error('Unknown project render input')
  if (name.startsWith('__runtime/')) throw new Error('Episode authored input conflicts with the captured runtime directory')
  return name
}

/**
 * Capture the actual owner modules before publishing one live renderer instance.
 * @param options - Trusted installation/test carrier and validated deployment facts.
 * @param signal - Provider activation cancellation.
 * @returns The instance whose captures retain these exact loaded-code facts.
 */
export async function createConfiguredEpisodeRenderer(
  options: EpisodeRendererOptions, signal: AbortSignal,
): Promise<ConfiguredEpisodeRenderer> {
  const paths = await ownerCodeFiles(options.codeFiles, options.limits.runtimeEntries, signal)
  const code = await Promise.all(paths.map(async path => await inspectEpisodeFile(path, signal)))
  return new ConfiguredEpisodeRenderer(options, code)
}

async function ownerCodeFiles(entries: readonly string[], maxEntries: number, signal: AbortSignal): Promise<readonly string[]> {
  const files = new Set<string>(), visited = new Set<string>()
  let count = 0
  const visit = async (root: string): Promise<void> => {
    if (visited.has(root)) return
    visited.add(root); signal.throwIfAborted()
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || (basename(root) === 'lib' && entry.name === 'types')) continue
      if (++count > maxEntries) throw new Error('Episode owner code exceeds the configured entry limit')
      const path = join(root, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Episode owner code contains a symbolic link')
      if (entry.isDirectory()) await visit(path)
      else if (/\.(?:[cm]?js|tsx?|node)$/u.test(entry.name) && !entry.name.endsWith('.d.ts')) files.add(await realpath(path))
    }
  }
  for (const entry of entries) {
    const path = await realpath(entry); files.add(path)
    if (/^episode-delivery\.[jt]s$/u.test(basename(path))) {
      const extension = extname(path)
      for (const module of ['episode-delivery-job', 'episode-execution']) files.add(await realpath(join(dirname(path), module + extension)))
    } else await visit(dirname(path))
  }
  return [...files].sort()
}

/** Product renderer provider loaded only by the private Desktop Host. */
export const name = 'approved-episode-renderer'
/** The actual preset declaration and local executable resolver are required. */
export const inject = ['agentPresets', 'subprocess']
/** Provider-owned deployment limits; the worker receives the same explicit values. */
export const Config = z.strictObject({
  runtimeDir: z.string().min(1), allowLinkedProfile: z.boolean().default(false), presetId: z.string().default('creation'),
  endingAssetRoot: z.string().min(1),
  requestBytes: z.number().int().positive().default(4096), replyBytes: z.number().int().positive().default(16384),
  descriptorBytes: z.number().int().positive().default(4 * 1024 * 1024), journalBytes: z.number().int().positive().default(2 * 1024 * 1024),
  lockWaitMs: z.number().int().positive().default(30_000),
  mediaGraceMs: z.number().int().positive().max(2147483647).default(1000),
  mediaStdoutBytes: z.number().int().positive().default(8 * 1024 * 1024),
  mediaStderrBytes: z.number().int().positive().default(8 * 1024 * 1024),
  diagnosticBytes: z.number().int().positive().default(8192), runtimeEntries: z.number().int().positive().default(4096),
})

const jsExpressionTag = { tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }
async function selectedRendererConfig(ctx: Context, preset: string): Promise<{ document: string; config: RendererConfig }> {
  const document = await ctx.agentPresets.readDocument(preset)
  const parsed: unknown = parseYaml(document.content, { customTags: [jsExpressionTag] })
  const rows = z.array(z.looseObject({ id: z.string().optional(), name: z.string(), config: z.unknown().optional() })).parse(parsed)
  const renderer = rows.filter(row => row.id === 'tool-episode-render' && row.name === '@deepseek-ai/dsh-tool-episode-render')
  if (renderer.length !== 1) throw new Error('The selected Desktop preset must declare exactly one episode renderer')
  const evaluated: unknown = interpolate(ctx, renderer[0]?.config)
  return { document: document.content, config: parseEpisodeRendererConfig(evaluated) }
}

/**
 * Register one provider whose configuration comes from the actual selected preset.
 * @param ctx - Desktop profile scope with preset registry and subprocess resolution.
 * @param config - Trusted installation paths and validated deployment limits.
 */
export function apply(ctx: Context, config: z.infer<typeof Config>): Promise<void> {
  const activation = new AbortController()
  let provider: ConfiguredEpisodeRenderer | undefined
  let preparation = Promise.resolve()
  let sourceAuthority: EpisodeSourceAuthorityFactory | undefined
  ctx.inject(['sessionController', 'agents', 'sessions', 'generationWorkspaceAuthority', 'workingDirectory',
    'fs', 'sandboxPolicy', 'sessionProjections', 'tools'], async (scope) => {
    const factory = await createEpisodeSourceAuthorityResolver(scope)
    scope.fiber.assertActive()
    scope.effect(() => {
      sourceAuthority = factory
      return () => { if (sourceAuthority === factory) sourceAuthority = undefined }
    }, 'episode.sourceAuthorityBinding')
  })
  ctx.effect(() => async () => {
    activation.abort(new Error('provider-disposed'))
    await preparation.catch((_activationFailed: unknown) => { /* The returned setup promise reports activation failure. */ })
    await provider?.dispose()
  }, 'configured episode renderer and guardian ownership')
  preparation = (async () => {
    const selected = await selectedRendererConfig(ctx, config.presetId)
    const carrier = await captureDesktopCarrier(config.runtimeDir, config.allowLinkedProfile)
    const worker = join(config.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'episode-render-worker.js')
    const limits: EpisodeRendererLimits = { requestBytes: config.requestBytes, replyBytes: config.replyBytes,
      descriptorBytes: config.descriptorBytes, journalBytes: config.journalBytes, lockWaitMs: config.lockWaitMs,
      mediaGraceMs: config.mediaGraceMs, mediaStdoutBytes: config.mediaStdoutBytes, mediaStderrBytes: config.mediaStderrBytes,
      diagnosticBytes: config.diagnosticBytes, runtimeEntries: config.runtimeEntries }
    provider = await createConfiguredEpisodeRenderer({ carrier, rendererConfig: selected.config,
      codeFiles: [fileURLToPath(import.meta.url), fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-tool-episode-render')),
        fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-tool-jubian/episode-delivery')), worker],
      endingAssetRoot: config.endingAssetRoot, limits, resolveExecutable: command => ctx.subprocess.resolveExecutable(command),
      sourceAuthority: async (sessionId, projectDir, signal, expected) => {
        if (sourceAuthority === undefined) throw new Error('SOURCE_QA_HOST_UNAVAILABLE: source authority is not mounted')
        return await sourceAuthority(sessionId, projectDir, signal, expected)
      },
      verifyConfiguration: async () => {
        const current = await selectedRendererConfig(ctx, config.presetId)
        if (current.document !== selected.document || episodeFactsHash(current.config) !== episodeFactsHash(selected.config)) {
          throw new Error('The actual episode-render preset changed; the captured provider must be replaced')
        }
      } }, activation.signal)
    activation.signal.throwIfAborted()
    ctx.provide('approvedEpisodeRenderer', provider)
  })()
  return preparation
}

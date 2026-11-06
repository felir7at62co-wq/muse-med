/** Instance-bound configured episode renderer with immutable staging and a separate guardian. */
import type { Context } from '@deepseek-ai/cordis'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { createHash, randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveSettings, stagedEpisodeEndingAssets } from '@deepseek-ai/dsh-tool-episode-render'
import type { Config as RendererConfig } from '@deepseek-ai/dsh-tool-episode-render'
import { executionIdentitySchema, readEpisodeRecord } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'
import type { ApprovedEpisodeCaptureInput, ApprovedEpisodeRenderer, ApprovedEpisodeRendererCapture, ApprovedEpisodeRenderInput,
  ApprovedEpisodeRuntimeInput, EpisodeRendererGeneration, EpisodeRenderResult } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'
import { captureDesktopCarrier, launchGuardian } from './episode-guardian-launcher.ts'
import type { CapturedDesktopCarrier, SourceDshFixture } from './episode-guardian-launcher.ts'
import { createGuardianJournal, guardianParsers } from './episode-guardian-journal.ts'
import { captureEpisodeDirectory, inspectEpisodeFile, stageEpisodeFile } from './episode-render-inputs.ts'
import type { EpisodeFileFact } from './episode-render-inputs.ts'
import { episodeCandidateSchema, episodeConfigurationSchema, episodeDescriptorSchema, episodeFactsHash,
  insideEpisodeRoot, parseEpisodeRendererConfig, readEpisodeDescriptor } from './episode-render-descriptor.ts'

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
      const identity = { generation, configurationSha256: episodeFactsHash(configuration), codeSha256: episodeFactsHash(runtimeInputs.filter(file => file.owner === 'renderer')) }
      active.throwIfAborted()
      return { identity, runtimeInputs, signal: lifetime,
        render: (execution, request) => this.own(async () => await this.renderCaptured(captured, configuration, identity,
          endings, execution, request)) }
    })
  }

  private async renderCaptured(capture: ApprovedEpisodeCaptureInput,
    configuration: z.infer<typeof episodeConfigurationSchema>, renderer: ApprovedEpisodeRendererCapture['identity'],
    endings: readonly EpisodeFileFact[], input: ApprovedEpisodeRenderInput, signal: AbortSignal): Promise<EpisodeRenderResult> {
    signal.throwIfAborted()
    if (this.closing) throw new Error('Episode renderer provider is closing before execution')
    if (input.identity.configurationSha256 !== renderer.configurationSha256 || !insideEpisodeRoot(input.job.attemptRoot, input.stageRoot)
      || await realpath(input.stageRoot) !== input.stageRoot) throw new Error('Episode execution does not match its captured renderer')
    if (input.sources.length === 0 || input.sources.some((source, index) => source.shot !== index + 1)
      || new Set(input.sources.map(source => source.idempotencyKey)).size !== input.sources.length) throw new Error('Episode sources must retain contiguous approved shot order')
    await this.options.verifyConfiguration()
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
    const rows = [...selected, ...sources, ...fonts, ...endingRows]
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
    const descriptor = episodeDescriptorSchema.parse({ version: 1, kind: 'approved-episode-render', identity: input.identity,
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
      candidatePath, candidateFactsPath: join(input.stageRoot, 'candidate-facts.json'), lastShot: input.sources.length, retry: input.retry })
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
    const completedDescriptor = await readEpisodeDescriptor(admitted.descriptorPath, completed.identity.descriptorSha256,
      this.options.limits.descriptorBytes)
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

/** Standalone named-profile renderer with captured inputs and guardian-owned media. */
import type { Context } from '@deepseek-ai/cordis'
import { join, resolve } from 'node:path'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { createEpisodeDeliveryJob, executionIdentitySchema, readEpisodeRecord } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'
import type { ExecutionIdentity } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'
import { runDramaRender, resolveSettings, prepareStagedEpisodeAudio, createSourceQaStagedAccess } from '@deepseek-ai/dsh-tool-episode-render'
import type { SourceQaEvidenceBinding } from '@deepseek-ai/dsh-tool-episode-render'
import { installEpisodeGuardian } from './episode-render-worker-core.ts'
import type { CapturedEpisodeExecution, GuardianWorkerConfig } from './episode-render-worker-core.ts'
import { createGuardianJournal } from './episode-guardian-journal.ts'
import { inspectEpisodeFile, captureEpisodeDirectory } from './episode-render-inputs.ts'
import { episodeCandidateSchema, episodePrivateFontFacts, readEpisodeDescriptor, readEpisodeDescriptorV3, readEpisodeDescriptorV4, episodeFactsHash, insideEpisodeRoot } from './episode-render-descriptor.ts'
import { verifyEpisodeSourceClaimFiles } from './episode-render-source-files.ts'
import type { EpisodeRenderDescriptor, EpisodeRenderDescriptorV3, EpisodeRenderDescriptorV4 } from './episode-render-descriptor.ts'

/** Private standalone worker plugin. */
export const name = 'desktop-episode-render-worker'
/** The normal CLI and owned native process provider are required. */
export const inject = ['subprocess', 'cmdlineArgs', 'appReady', 'appExit']
/** Validated limits supplied by the captured Host; no model or credentials configuration is accepted. */
export const Config = z.strictObject({
  descriptorPath: z.string().min(1), descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  requestBytes: z.number().int().positive(), replyBytes: z.number().int().positive(),
  descriptorBytes: z.number().int().positive(), journalBytes: z.number().int().positive(),
  lockWaitMs: z.number().int().positive(), mediaGraceMs: z.number().int().positive().max(2147483647),
  runtimeEntries: z.number().int().positive(),
  mediaStdoutBytes: z.number().int().positive(), mediaStderrBytes: z.number().int().positive(),
  diagnosticBytes: z.number().int().positive(),
})

async function verifyFiles(
  descriptor: EpisodeRenderDescriptor | EpisodeRenderDescriptorV3 | EpisodeRenderDescriptorV4, runtimeEntries: number,
  signal: AbortSignal): Promise<void> {
  const settings = resolveSettings(descriptor.config)
  if (descriptor.version === 4) await verifyEpisodeSourceClaimFiles(descriptor, 'stage', signal)
  const staged = new Map(descriptor.stagedFiles.map(file => [file.path, file]))
  if (descriptor.version !== 1 && descriptor.clockInputs.clock === undefined) {
    let exists = true
    try { await lstat(`${descriptor.subtitlePath}.clock.json`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw error }
    if (exists) throw new Error('Episode private stage unexpectedly contains a subtitle clock')
  }
  const required = [descriptor.timelinePath, descriptor.subtitlePath, descriptor.mixProfilePath, descriptor.bgmPath,
    descriptor.endingAudio, descriptor.endingEffect].filter((file): file is string => file !== undefined)
  if (new Set(descriptor.stagedFiles.map(file => file.path)).size !== descriptor.stagedFiles.length
    || required.some(file => !staged.has(file))) throw new Error('Episode renderer paths have no exact staged file record')
  if (await realpath(descriptor.stageRoot) !== descriptor.stageRoot || await realpath(descriptor.attemptRoot) !== descriptor.attemptRoot) {
    throw new Error('Episode execution roots changed')
  }
  for (const file of [...descriptor.stagedFiles.map(fact => ({ fact, role: 'staged' })),
    ...descriptor.configuration.runtimeInputs.filter(fact => fact.owner !== 'font').map(fact => ({ fact, role: fact.owner }))]) {
    let actual: Awaited<ReturnType<typeof inspectEpisodeFile>>
    const path = JSON.stringify(file.fact.path.slice(0, 512))
    try { actual = await inspectEpisodeFile(file.fact.path, signal) }
    catch (error) {
      signal.throwIfAborted()
      throw new Error(`Episode staged or runtime file changed: ${file.role} ${path} identity/read check failed`, { cause: error })
    }
    const differences = [actual.sha256 !== file.fact.sha256 && 'sha256', actual.bytes !== file.fact.bytes && 'bytes'].filter(Boolean)
    if (differences.length > 0) throw new Error(`Episode staged or runtime file changed: ${file.role} ${path} ${differences.join('/')} mismatch`)
  }
  if (!insideEpisodeRoot(descriptor.stageRoot, settings.fontsDir)) throw new Error('Episode fonts must use the captured private directory')
  const fonts = await captureEpisodeDirectory(settings.fontsDir, runtimeEntries, signal)
  const expectedFonts = episodePrivateFontFacts(descriptor)
  if (fonts.length !== expectedFonts.length || fonts.some((file) => {
    const expected = expectedFonts.find(row => row.path === file.path), captured = staged.get(file.path)
    return expected === undefined || captured === undefined || expected.sha256 !== file.sha256 || expected.bytes !== file.bytes
      || captured.sha256 !== expected.sha256 || captured.bytes !== expected.bytes
  })) throw new Error('Episode private font inventory changed')
  if (!descriptor.configuration.runtimeInputs.some(file => file.owner === 'media' && file.path === settings.ffmpeg)
    || !descriptor.configuration.runtimeInputs.some(file => file.owner === 'media' && file.path === settings.ffprobe)) {
    throw new Error('Episode renderer executables were not captured')
  }
}

/** Compare audio stream format and losslessly decoded PCM, independent of WAV metadata. */
async function assertMasterMatchesSelectedAudio(master: string, rebuilt: string, stage: string,
  channel: import('@deepseek-ai/dsh-tool-episode-render').ProcessChannel, settings: ReturnType<typeof resolveSettings>,
  signal: AbortSignal): Promise<void> {
  const probe = async (path: string) => {
    const result = await channel.run(settings.ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
      'stream=sample_rate,channels,channel_layout', '-of', 'json', path])
    if (result.code !== 0) throw new Error('Unable to inspect the original audio master: ' + result.stderr)
    return z.object({ streams: z.array(z.object({ sample_rate: z.string().min(1), channels: z.number().int().positive(),
      channel_layout: z.string().optional() })).length(1) }).parse(JSON.parse(result.stdout)).streams[0]
  }
  const [actual, expected] = await Promise.all([probe(master), probe(rebuilt)])
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('整集原声与已核验原音轨的音频格式不符。')
  const decode = async (source: string, output: string) => {
    const result = await channel.run(settings.ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-n', '-i', source,
      '-map', '0:a:0', '-c:a', 'pcm_s16le', '-f', 's16le', output])
    if (result.code !== 0) throw new Error('Unable to decode the audio master: ' + result.stderr)
    return await inspectEpisodeFile(output, signal)
  }
  const [left, right] = await Promise.all([decode(master, join(stage, '__source-qa-master.pcm')),
    decode(rebuilt, join(stage, '__source-qa-rebuilt.pcm'))])
  if (left.sha256 !== right.sha256 || left.bytes !== right.bytes) {
    throw new Error('整集原声与已核验的原音轨及时间线不符，请重新 prepare。')
  }
}

/**
 * Mount only in the fresh empty worker profile prepared by the trusted Host.
 * @param ctx - Normal dsh scope with subprocess and launcher facts.
 * @param config - Validated descriptor reference and deployment limits.
 */
export function apply(ctx: Context, config: GuardianWorkerConfig & { readonly runtimeEntries: number }): void {
  let descriptor: EpisodeRenderDescriptor | EpisodeRenderDescriptorV3 | EpisodeRenderDescriptorV4 | undefined
  let identity: ExecutionIdentity | undefined
  let job: Awaited<ReturnType<typeof createEpisodeDeliveryJob>> | undefined
  installEpisodeGuardian(ctx, config, () => ({
    load: async (limits, request, signal) => {
      const profile = ctx.get('profileContext')
      if (profile?.name !== 'desktop-episode-render-worker' || profile.startedBundles.length !== 0
        || ctx.get('cmdlineArgs')?.get().length !== 0) throw new Error('Episode worker requires its private empty named profile')
      const packageManifest = z.looseObject({ dependencies: z.record(z.string(), z.never()),
        dsh: z.object({ profile: z.object({ bundles: z.array(z.string()).length(0) }) }) })
      const packageValue: unknown = JSON.parse(await readFile(join(profile.dir, 'package.json'), 'utf8'))
      packageManifest.parse(packageValue)
      if (limits.descriptorSha256 !== request.identity.descriptorSha256) throw new Error('Episode launcher and request descriptor hashes differ')
      try { descriptor = await readEpisodeDescriptor(limits.descriptorPath, request.identity.descriptorSha256, limits.descriptorBytes) }
      catch (_notV1: unknown) {
        try { descriptor = await readEpisodeDescriptorV3(limits.descriptorPath, request.identity.descriptorSha256, limits.descriptorBytes) }
        catch (_notV3: unknown) {
          descriptor = await readEpisodeDescriptorV4(limits.descriptorPath, request.identity.descriptorSha256, limits.descriptorBytes)
        }
      }
      identity = executionIdentitySchema.parse({ ...descriptor.identity, execution: descriptor.execution,
        descriptorSha256: request.identity.descriptorSha256 })
      for (const key of ['attempt', 'execution', 'rendererGeneration', 'configurationSha256', 'planSha256', 'projectSha256', 'descriptorSha256'] as const) {
        if (identity[key] !== request.identity[key]) throw new Error('Episode request differs from its captured descriptor')
      }
      job = await createEpisodeDeliveryJob({ projectDir: descriptor.originalProject, identity: descriptor.identity,
        recordBytes: limits.journalBytes, lockWaitMs: limits.lockWaitMs })
      const logical = await job.read()
      if (logical === undefined || logical.projectDir !== descriptor.originalProject || job.attemptRoot !== descriptor.attemptRoot) {
        throw new Error('Episode worker has no exact admitted logical job')
      }
      if (descriptor.projectFiles.length !== descriptor.configuration.projectInputs.length
        || descriptor.projectFiles.some((file) => {
          const original = descriptor?.configuration.projectInputs.find(row => row.path === file.originalPath)
          const staged = descriptor?.stagedFiles.find(row => row.path === file.path)
          return original === undefined || staged === undefined || original.sha256 !== file.sha256 || original.bytes !== file.bytes
            || staged.sha256 !== file.sha256 || staged.bytes !== file.bytes
        })) throw new Error('Episode authored input has no exact captured and staged record')
      const planFile = descriptor.projectFiles.filter(file => file.role === 'plan')
      if (planFile.length !== 1) throw new Error('Episode worker requires exactly one captured plan')
      const plan = z.looseObject({ episode: z.number().int().positive(), total_shots: z.number().int().positive(),
        shots: z.array(z.strictObject({ shot: z.number().int().positive(), idempotency_key: z.string().min(1),
          review_digest: z.string().regex(/^[a-f0-9]{64}$/u) })) }).parse(await readEpisodeRecord(planFile[0]?.path ?? '', limits.descriptorBytes))
      if (plan.episode !== descriptor.configuration.episode || plan.total_shots !== descriptor.stagedSources.length
        || plan.shots.length !== descriptor.stagedSources.length || descriptor.stagedSources.some((source, index) => {
        const shot = plan.shots[index]
        return shot?.shot !== source.shot || shot.idempotency_key !== source.idempotencyKey || shot.review_digest !== source.digest
      })) throw new Error('Episode staged shot order differs from the captured plan')
      if (descriptor.stagedSources.length !== logical.approvals.length || descriptor.stagedSources.some((source, index) => {
        const approval = logical.approvals.find(item => item.idempotencyKey === source.idempotencyKey)
        const staged = descriptor?.stagedFiles.find(file => file.path === source.path)
        return source.shot !== index + 1 || approval === undefined || approval.digest !== source.digest || approval.sha256 !== source.sha256
          || staged === undefined || staged.sha256 !== source.sha256 || staged.bytes !== source.bytes
      })) throw new Error('Episode staged source does not match the original approved job')
      await verifyFiles(descriptor, config.runtimeEntries, signal)
      const settings = resolveSettings(descriptor.config)
      return { identity, stageRoot: descriptor.stageRoot, ffmpeg: settings.ffmpeg, ffprobe: settings.ffprobe, retry: descriptor.retry }
    },
    journal: (_execution, limits) => {
      if (job === undefined) throw new Error('Episode worker job is not loaded')
      const owner = job
      return createGuardianJournal({ attemptRoot: owner.attemptRoot, recordBytes: limits.journalBytes,
        assertAdmission: value => owner.assertAdmission(value), armExecution: record => owner.armExecution(record) })
    },
    render: async (_execution: CapturedEpisodeExecution, channel, signal) => {
      if (descriptor === undefined || identity === undefined) throw new Error('Episode worker descriptor is not loaded')
      const captured = descriptor
      await verifyFiles(captured, config.runtimeEntries, signal)
      const settings = { ...resolveSettings(captured.config), channel }
      const episode = String(captured.configuration.episode).padStart(2, '0')
      if (captured.version === 1 || captured.clockInputs.master === undefined) {
        const audioPaths = captured.version !== 1 ? captured.clockStage.audio.map(row => row.stagedPath) : undefined
        await prepareStagedEpisodeAudio({ project: captured.stageRoot, episode, timelinePath: captured.timelinePath,
          ...(audioPaths === undefined ? {} : { audioPaths }) }, settings)
      }
      if (captured.version === 4 && captured.clockInputs.master !== undefined) {
        const proofOutputPath = join(captured.stageRoot, '__source-qa-master-proof.wav')
        await prepareStagedEpisodeAudio({ project: captured.stageRoot, episode, timelinePath: captured.timelinePath,
          audioPaths: captured.clockStage.audio.map(row => row.stagedPath), proofOutputPath }, settings)
        if (captured.clockStage.masterPath === undefined) throw new Error('Episode staged audio master is missing')
        await assertMasterMatchesSelectedAudio(captured.clockStage.masterPath, proofOutputPath, captured.stageRoot,
          channel, settings, signal)
      }
      const stagedAudio = captured.version !== 1 ? (sourceAudio: string): string => {
        const original = resolve(captured.originalProject, sourceAudio)
        const matches = captured.clockStage.audio.filter(row => row.originalPath === original)
        const first = matches[0]
        if (first === undefined) throw new Error('字幕音轨缺少已捕获的暂存对应文件。')
        return first.stagedPath
      } : undefined
      const sourceQaStage = captured.version !== 4 ? undefined : createSourceQaStagedAccess(captured.originalProject,
        captured.stageRoot, captured.sourceClaim.files.map(({ originalPath, stagedPath, sha256, bytes, aliases }) => ({
          originalPath, stagedPath, sha256, bytes, ...(aliases === undefined ? {} : { aliases }),
        })), signal, captured.sourceClaim.directories)
      const sourceQaVerifier = captured.version !== 4 ? undefined : async (binding: SourceQaEvidenceBinding) => {
        const count = captured.sourceEvidence.bindings.filter(expected => episodeFactsHash(expected) === episodeFactsHash(binding)).length
        if (count !== 1 || sourceQaStage === undefined) throw new Error('Source review was not verified by the captured Host')
        const hashes = await Promise.all([sourceQaStage.hash(binding.mediaPath), sourceQaStage.hash(binding.ocrPath),
          sourceQaStage.hash(binding.inspectionPath)])
        if (hashes[0] !== binding.mediaSha256 || hashes[1] !== binding.ocrSha256 || hashes[2] !== binding.inspectionSha256) {
          throw new Error('Private source review evidence changed')
        }
      }
      const report = await runDramaRender({ method: 'render', project: captured.stageRoot, episode: captured.configuration.episode,
        timeline: captured.timelinePath, subtitleSrt: captured.subtitlePath, mixProfile: captured.mixProfilePath,
        lastShot: captured.lastShot, output: captured.candidatePath, force: false,
        ...(captured.bgmPath === undefined ? {} : { bgm: captured.bgmPath }),
        ...(captured.endingAudio === undefined ? {} : { endingAudio: captured.endingAudio }),
        ...(captured.endingEffect === undefined ? {} : { endingEffect: captured.endingEffect }) },
      settings, sourceQaVerifier, stagedAudio, sourceQaStage, captured.version === 4 ? captured.sourceEvidence.sourceQaSha256 : undefined)
      if (!report.ok || report.media.video_codec === '' || report.media.audio_codec === '') {
        throw new Error('Episode renderer checks failed: ' + report.failures.join('; '))
      }
      const decode = await channel.run(settings.ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-xerror', '-i', captured.candidatePath,
        '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
      if (decode.code !== 0) throw new Error('Episode candidate full audio/video decode failed: ' + decode.stderr)
      await verifyFiles(captured, config.runtimeEntries, signal)
      const file = await inspectEpisodeFile(captured.candidatePath, signal)
      const candidate = episodeCandidateSchema.parse({ ...file, width: report.media.width, height: report.media.height,
        durationUs: Math.round(report.media.duration_seconds * 1_000_000), video: true, audio: true })
      await writeFile(captured.candidateFactsPath, JSON.stringify(candidate) + '\n', { mode: 0o600, flag: 'wx' })
      // A completed result is returned only after the core independently drains every command.
      return { outputSha256: candidate.sha256, outputBytes: candidate.bytes }
    },
  }))
}

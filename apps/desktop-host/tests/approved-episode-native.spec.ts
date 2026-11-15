/** Production ToolJubian composition and actual source guardian produce one verified local episode. */
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, copyFile, mkdtemp, realpath, rm, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { initProfile, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { guardianEnvironment } from '../src/episode-guardian-launcher.ts'
import { createVideoRecoveryProjectFixture } from '../../../packages/jubian/tool-jubian/tests/fixtures/video-recovery-service.ts'
import { writeSubtitleClock } from '../../../packages/drama/tool-episode-render/src/subtitle-clock.ts'
import { preparedSubtitleClockInputs } from '@deepseek-ai/dsh-tool-episode-render'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { JubianVideoRecovery } from '../../../packages/jubian/tool-jubian/src/video-recovery-service.ts'
import { JubianEpisodeDelivery } from '../../../packages/jubian/tool-jubian/src/episode-delivery-service.ts'
import { readApprovedEpisodePlan } from '../../../packages/jubian/tool-jubian/src/approved-episode-plan.ts'
import { createConfiguredEpisodeRenderer } from '../src/approved-episode-render.ts'
import { createEpisodeSourceAuthorityFixture } from './fixtures/episode-source-authority.ts'

// The synthetic migration root is private; the running user Host must not be stopped.
vi.mock('../src/workspace-handoff.ts', () => ({ assertWorkspaceMigrationHandoff: vi.fn(async () => undefined) }))

const ffmpeg = process.env.MUSE_EPISODE_TEST_FFMPEG
const ffprobe = process.env.MUSE_EPISODE_TEST_FFPROBE
const font = process.env.MUSE_EPISODE_TEST_FONT
const enabled = process.platform === 'darwin' && ffmpeg !== undefined && ffprobe !== undefined && font !== undefined
const execute = promisify(execFile)

async function fixture(tamper = false, clock: 'none' | 'stale' | 'valid' | 'valid-separate' | 'manual-separate' | 'legacy-manual-separate' = 'none') {
  if (ffmpeg === undefined || ffprobe === undefined || font === undefined) throw new Error('Explicit reviewed native resources are required')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-approved-native-')))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const source = join(root, 'synthetic.mp4')
  await execute(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=s=1440x2560:r=60,noise=alls=60:allf=t+u', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '1', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '16M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source],
  { timeout: 90000, maxBuffer: 131072 })
  const data = await createVideoRecoveryProjectFixture({ sourceBytes: await readFile(source) })
  await writeFile(join(data.project, 'project_config.json'), JSON.stringify({ jubian_script_id: 1,
    project_bible: { visual_medium: 'animation_3d', delivery: { width: 1440, height: 2560, fps: 60 } } }))
  const editing = join(data.project, 'editing'); await mkdir(editing)
  await writeFile(join(editing, '01-episode-delivery.json'), JSON.stringify({ schema_version: 1, episode: 1, total_shots: 1,
    shots: [{ shot: 1, idempotency_key: data.key, review_digest: data.input.digest }],
    timeline: 'editing/timeline.json', subtitle_srt: 'editing/subtitle.srt', mix_profile: 'editing/mix.json' }))
  await writeFile(join(editing, 'timeline.json'), JSON.stringify({ clips: [{ shot: 1, start_us: 0, duration_us: 1000000 }], body_end: 1,
    delivery: { width: 1440, height: 2560, fps: 60, visual_medium: 'animation_3d' } }))
  await writeFile(join(editing, 'subtitle.srt'), '1\n00:00:00,000 --> 00:00:00,900\n原声保留\n')
  if (clock !== 'none') {
    const video = join(data.project, 'video', '01', 'shot_001.mp4')
    await mkdir(join(data.project, 'video', '01'), { recursive: true }); await copyFile(source, video)
    const audio = join(data.project, 'audio', '01.wav')
    await mkdir(join(data.project, 'audio'), { recursive: true })
    await execute(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-i', source, '-vn', '-c:a', 'pcm_s16le', '-ar', '48000', audio])
    const videoSha = createHash('sha256').update(await readFile(video)).digest('hex')
    const selectedAudio = clock === 'valid-separate' || clock === 'manual-separate' || clock === 'legacy-manual-separate' ? join(data.project, 'audio', 'source.wav') : video
    if (clock === 'valid-separate' || clock === 'manual-separate' || clock === 'legacy-manual-separate') {
      await execute(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-f', 'lavfi',
        '-i', 'sine=frequency=880:sample_rate=48000', '-t', '1', '-c:a', 'pcm_s16le', selectedAudio])
      await copyFile(selectedAudio, audio)
    }
    const masterSha = createHash('sha256').update(await readFile(audio)).digest('hex')
    await writeFile(join(editing, '01-sources.json'), JSON.stringify({ shots: [{ shot: 1, video,
      ...(selectedAudio === video ? {} : { audio: selectedAudio }), sha256: videoSha }],
    ...(clock === 'legacy-manual-separate' ? {} : { master_audio_sha256: masterSha, timeline_clips: [{ shot: 1, start_us: 0, duration_us: 1000000 }] }) }))
    const subtitle = join(editing, 'subtitle.srt')
    if (clock !== 'manual-separate' && clock !== 'legacy-manual-separate') {
      await writeSubtitleClock(subtitle, await readFile(subtitle, 'utf8'), '01', [
        { source: { shot: 1, video, audio: selectedAudio }, video, audio: selectedAudio, durationUs: 1000000 },
      ])
      if (clock === 'stale') await writeFile(`${subtitle}.clock.json`, JSON.stringify({ version: 1,
        srt_sha256: '0'.repeat(64), source_clock_sha256: '0'.repeat(64) }))
      else await preparedSubtitleClockInputs(data.project, '01', join(editing, 'timeline.json'), subtitle, true)
    }
  }
  await writeFile(join(editing, 'mix.json'), '{"schema_version":1,"mode":"no_bgm","analysis_window_ms":50,"original_gain":1,"music_gain":0}')
  const fonts = join(root, 'fonts'); await mkdir(fonts); await copyFile(font, join(fonts, 'NotoSansCJKsc-Regular.otf'))
  const home = join(root, 'home'); await mkdir(home)
  const profile = resolveProfileDir('approved-episode-native', home); initProfile(profile, [])
  let run = 0
  const launchHost = async (resume = false) => {
    const result = join(root, `result-${++run}.json`), patch = join(root, `host-${run}.overlay.json`)
    const moduleUrl = (path: string) => new URL(path, import.meta.url).href
    await writeFile(patch, JSON.stringify([{ insert: [
      { id: 'subprocess', name: moduleUrl('../../../packages/subprocess/subprocess-local/src/index.ts') },
      { id: 'system-prompt', name: moduleUrl('../../../packages/core/system-prompt/src/index.ts') },
      { id: 'tools', name: moduleUrl('../../../packages/core/tools/src/index.ts') },
      { id: 'credentials', name: moduleUrl('../../../packages/credentials/credentials-local/src/index.ts'), config: { path: join(home, 'credentials.yml'), watch: false } },
      { id: 'native-fixture', name: moduleUrl('./fixtures/approved-episode-native-host.mjs'), config: {
        project: data.project, ledgerRoot: join(data.root, 'ledger'), review: data.input, result, ffmpeg, resume,
        endingAssetRoot: fileURLToPath(new URL('../../../packages/drama/skills/skills', import.meta.url)),
        limits: { requestBytes: 4096, replyBytes: 16384, descriptorBytes: 4194304, journalBytes: 2097152, lockWaitMs: 30000,
          mediaGraceMs: 1000, mediaStdoutBytes: 8388608, mediaStderrBytes: 8388608, diagnosticBytes: 8192, runtimeEntries: 4096 },
        carrier: { kind: 'source-fixture', executable: process.execPath, cli: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)),
          tsxEsm: import.meta.resolve('tsx/esm'), tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
          subprocessEntry: fileURLToPath(new URL('../../../packages/subprocess/subprocess-local/src/index.ts', import.meta.url)),
          workerEntry: fileURLToPath(new URL(tamper ? './fixtures/approved-episode-tamper-worker.mjs' : '../src/episode-render-worker.ts', import.meta.url)) },
      } },
    ] }]))
    const env = { ...guardianEnvironment(home, process.platform), DSH_FFMPEG_PATH: ffmpeg, DSH_FFPROBE_PATH: ffprobe,
      MUSE_FONTS_DIR: fonts, MUSE_SUBTITLE_FONT_FAMILY: 'Noto Sans CJK SC', MUSE_WATERMARK_FONT_FAMILY: 'Noto Sans CJK SC' }
    const launch = resolveExampleLaunch({ mode: 'src', srcBin: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)),
      sourceImport: 'tsx/esm', tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
      configArgs: ['--profile', 'approved-episode-native', '--patch', patch], env })
    const child = spawn(launch.command, ['--expose-internals', ...launch.args], { cwd: profile, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    let diagnostic = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', (bytes: Buffer) => { diagnostic = (diagnostic + bytes.toString()).slice(-32768) })
    onTestFinished(async () => {
      child.stdin.end()
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await closed
    })
    const observed = Promise.withResolvers<{ attempt: string; execution?: string }>()
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let value: unknown
      try { value = JSON.parse(line) } catch (_diagnostic) { return }
      const parsed = z.object({ kind: z.literal('state'), state: z.literal('running'), attempt: z.string(), execution: z.string() }).safeParse(value)
      if (parsed.success) observed.resolve(parsed.data)
    })
    void closed.then(() => { lines.close() }, () => { lines.close() })
    return { child, closed, result, diagnostic: () => diagnostic,
      running: async () => await Promise.race([observed.promise, closed.then((value) => { throw new Error('Host exited before rendering: ' + JSON.stringify(value) + diagnostic) })]) }
  }
  return { root, data, launchHost }
}

type NativeFixture = Awaited<ReturnType<typeof fixture>>
type NativeHost = Awaited<ReturnType<NativeFixture['launchHost']>>

async function completed(f: NativeFixture, host: NativeHost) {
  expect(await host.closed, host.diagnostic()).toEqual({ code: 0, signal: null })
  const receipt = z.object({ productionComposition: z.literal(true), fetchCalls: z.literal(0), ready: z.object({ ready: z.literal(true) }),
    status: z.object({ state: z.literal('completed'), attempt: z.string(), execution: z.string(), output: z.object({ path: z.string(), sha256: z.string(), bytes: z.number().positive() }) }) })
    .parse(JSON.parse(await readFile(host.result, 'utf8')))
  const bytes = await readFile(join(f.data.project, receipt.status.output.path))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(receipt.status.output.sha256)
  expect(bytes.length).toBe(receipt.status.output.bytes)
  expect(f.data.fetch).not.toHaveBeenCalled()
  console.info(JSON.stringify({ kind: 'actual-episode-native-complete', ...receipt }))
  return receipt
}

it.skipIf(!enabled)('runs production admission, an ordinary isolated guardian and actual current rendering without a provider call', async () => {
  const f = await fixture()
  await completed(f, await f.launchHost())
}, 180000)

it.skipIf(!enabled)('retains a verified generated subtitle clock and original audio in the private guardian', async () => {
  const f = await fixture(false, 'valid')
  await completed(f, await f.launchHost())
}, 180000)

it.skipIf(!enabled).each(['valid-separate', 'manual-separate', 'legacy-manual-separate'] as const)(
  'uses the selected separate audio for subtitle mode %s', async (clock) => {
    const f = await fixture(false, clock)
    const receipt = await completed(f, await f.launchHost())
    if (ffmpeg === undefined) throw new Error('FFmpeg is required')
    const pcm = join(f.root, 'output.pcm')
    await execute(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-i', join(f.data.project, receipt.status.output.path),
      '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 's16le', pcm])
    const data = await readFile(pcm)
    const strength = (frequency: number): number => {
      let real = 0, imaginary = 0
      for (let index = 400; index < Math.min(data.length / 2, 7600); index += 1) {
        const sample = data.readInt16LE(index * 2), angle = 2 * Math.PI * frequency * index / 8000
        real += sample * Math.cos(angle); imaginary += sample * Math.sin(angle)
      }
      return Math.hypot(real, imaginary)
    }
    expect(strength(880)).toBeGreaterThan(10 * strength(440))
  }, 180000)

it.skipIf(!enabled).each(['legacy', 'valid-master', 'wrong-master', 'publication-disposal'] as const)(
  'renders strict reviewed video and original audio in an owned guardian (%s)', async (master) => {
    if (ffmpeg === undefined || ffprobe === undefined || font === undefined) throw new Error('Explicit reviewed native resources are required')
    const f = await fixture(false, 'legacy-manual-separate')
    const project = f.data.project, selected = join(project, 'video', '01', 'shot_001.mp4')
    const original = join(project, 'audio', 'original.mp4')
    await execute(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-f', 'lavfi',
      '-i', 'testsrc2=s=1440x2560:r=60', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
      '-t', '1', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', original])
    await writeFile(join(project, 'project_config.json'), JSON.stringify({ jubian_script_id: 1,
      project_bible: { visual_medium: 'animation_3d', delivery: { width: 1440, height: 2560, fps: 60, require_source_review: true } } }))
    const sessionCache = join(f.data.root, '.muse', 'source-qa')
    await mkdir(sessionCache, { recursive: true })
    const owner = await createEpisodeSourceAuthorityFixture({ root: f.data.root, project,
      inputs: [{ mediaPath: selected, durationSeconds: 1, ocrPath: join(sessionCache, 'selected-ocr.json'),
        inspectionPath: join(sessionCache, 'selected-review.json') },
      { mediaPath: original, durationSeconds: 1, ocrPath: join(sessionCache, 'original-ocr.json'),
        inspectionPath: join(sessionCache, 'original-review.json') }] })
    const [selectedReview, originalReview] = owner.reviews
    if (selectedReview === undefined || originalReview === undefined) throw new Error('Two real source reviews are required')
    const declaration = (binding: typeof selectedReview.binding) => ({ media_path: binding.mediaPath, media_sha256: binding.mediaSha256,
      ocr: { path: binding.ocrPath, sha256: binding.ocrSha256 }, inspection: { path: binding.inspectionPath,
        sha256: binding.inspectionSha256, session_id: binding.sessionId, review_id: binding.reviewId }, text_decisions: [] })
    const packagePath = join(project, 'episode_packages', '01', 'package.json')
    await mkdir(dirname(packagePath), { recursive: true })
    await writeFile(packagePath, JSON.stringify({ episode: '01', video_tasks: [{ shots: [1] }] }))
    const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
    const frame = join(project, 'review-frame.png'), selectedReceipt = join(project, 'selected-receipt.json')
    const originalReceipt = join(project, 'original-receipt.json'), outputUrlSha = 'a'.repeat(64)
    await writeFile(frame, 'synthetic frame evidence')
    const receipt = async (path: string, media: string, sourceSha: string) => writeFile(path, JSON.stringify({ version: 1,
      kind: 'video', media_type: 'video/mp4', path: media, sha256: `sha256:${sha(await readFile(media))}`, source_sha256: sourceSha }))
    await receipt(selectedReceipt, selected, outputUrlSha)
    await receipt(originalReceipt, original, 'b'.repeat(64))
    const checks = Object.fromEntries(['identity', 'wardrobe', 'scene', 'prop', 'action_and_dialogue', 'visible_artifacts',
      'continuity', 'voice_and_speaker', 'av_sync', 'sensitive_content'].map(key => [key, 'pass']))
    const reviewPath = join(project, 'reviews', 'ep01-p01.json')
    await mkdir(dirname(reviewPath), { recursive: true })
    await writeFile(reviewPath, JSON.stringify({ episode: '01', package: 1, status: 'approved', subtitle_cleanup: 'clean',
      package_sha256: sha(await readFile(packagePath)), video_path: selected, video_sha256: selectedReview.binding.mediaSha256,
      audio_path: original, audio_sha256: originalReview.binding.mediaSha256,
      content_review: { ...checks, embedded_subtitles: 'absent' }, review_frames: [frame],
      original_download_receipt_path: originalReceipt, subtitle_erasure: { stage: 'erase_subtitle', source_task_id: 1,
        operation_task_id: 2, result_id: 3, output_url_sha256: outputUrlSha, download_receipt_path: selectedReceipt },
      source_qa: { version: 1, selected: declaration(selectedReview.binding), original: declaration(originalReview.binding),
        affected_intervals: [{ start_seconds: 0, end_seconds: 1 }] } }))
    const masterPath = join(project, 'audio', '01.wav')
    if (master !== 'legacy' && master !== 'publication-disposal') {
      const input = master === 'valid-master' ? original : selected
      await execute(ffmpeg, ['-nostdin', '-hide_banner', '-y', '-v', 'error', '-i', input, '-filter_complex',
        '[0:a]atrim=0:1.000000,asetpts=N/SR/TB,adelay=delays=0:all=1[a0];[a0]amix=inputs=1:duration=longest:normalize=0[a]',
        '-map', '[a]', '-c:a', 'pcm_s16le', '-ar', '48000', masterPath])
      if (master === 'valid-master') {
        const decorated = join(project, 'audio', 'metadata-master.wav')
        await execute(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-i', masterPath,
          '-map_metadata', '-1', '-metadata', 'comment=fixture metadata', '-c:a', 'copy', decorated])
        await copyFile(decorated, masterPath)
      }
    }
    await writeFile(join(project, 'editing', '01-sources.json'), JSON.stringify({ shots: [{ shot: 1, package: 1,
      video: selected, audio: original, sha256: selectedReview.binding.mediaSha256, audio_sha256: originalReview.binding.mediaSha256,
      review_sha256: sha(await readFile(reviewPath)) }], ...(master === 'legacy' || master === 'publication-disposal' ? {} : {
      master_audio_sha256: sha(await readFile(masterPath)), timeline_clips: [{ shot: 1, start_us: 0, duration_us: 1000000 }] }) }))
    const fonts = join(f.root, 'strict-fonts'); await mkdir(fonts); await copyFile(font, join(fonts, 'NotoSansCJKsc-Regular.otf'))
    if (owner.ctx.get('subprocess') === undefined) await owner.ctx.plugin(SubprocessLocal)
    await owner.ctx.plugin(JubianVideoRecovery, { ...f.data.options, ffmpegPath: ffmpeg,
      decodeTimeoutMs: 30000, decodeGraceMs: 100, decodeMaxOutputBytes: 131072 })
    await owner.ctx.jubianVideoRecovery.configure({ enabled: false, projectDir: project })
    await owner.ctx.jubianVideoRecovery.review({ ...f.data.input, action: 'approve' })
    const limits = { requestBytes: 4096, replyBytes: 16384, descriptorBytes: 4194304, journalBytes: 2097152, lockWaitMs: 30000,
      mediaGraceMs: 1000, mediaStdoutBytes: 8388608, mediaStderrBytes: 8388608, diagnosticBytes: 8192, runtimeEntries: 4096 }
    const cli = fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url))
    const worker = fileURLToPath(new URL('../src/episode-render-worker.ts', import.meta.url))
    const renderer = await createConfiguredEpisodeRenderer({ rendererConfig: { ffmpegPath: ffmpeg, ffprobePath: ffprobe,
      fontsDir: fonts, subtitleFontFamily: 'Noto Sans CJK SC', watermarkFontFamily: 'Noto Sans CJK SC' },
    carrier: { kind: 'source-fixture', executable: process.execPath, cli, tsxEsm: import.meta.resolve('tsx/esm'),
      tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
      subprocessEntry: fileURLToPath(new URL('../../../packages/subprocess/subprocess-local/src/index.ts', import.meta.url)), workerEntry: worker },
    codeFiles: [fileURLToPath(new URL('../src/approved-episode-render.ts', import.meta.url)),
      fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-tool-episode-render')),
      fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-tool-jubian/episode-delivery')), worker],
    endingAssetRoot: fileURLToPath(new URL('../../../packages/drama/skills/skills', import.meta.url)), limits,
    resolveExecutable: command => owner.ctx.subprocess.resolveExecutable(command),
    verifyConfiguration: async () => {}, sourceAuthority: owner.factory },
    new AbortController().signal)
    onTestFinished(async () => { await renderer.dispose() })
    owner.ctx.provide('approvedEpisodeRenderer', renderer)
    await owner.ctx.plugin(JubianEpisodeDelivery, { metadataMaxBytes: 1048576, recordBytes: 2097152, lockWaitMs: 30000,
      historyScanLimit: 1000, historyResultLimit: 50, historyMetadataMaxBytes: 4194304 })
    const episode = owner.ctx.jubianEpisodeDelivery
    const inspectionBytes = await readFile(selectedReview.binding.inspectionPath)
    await writeFile(selectedReview.binding.inspectionPath, Buffer.concat([inspectionBytes, Buffer.from('tamper')]))
    const stale = await episode.episodeReadiness({ projectDir: project, episode: 1 })
    expect(stale.ready).toBe(false)
    expect(stale.issues.length).toBeGreaterThan(0)
    await writeFile(selectedReview.binding.inspectionPath, inspectionBytes)
    const ready = await episode.episodeReadiness({ projectDir: project, episode: 1 })
    expect(ready.issues).toEqual([])
    expect(ready.digest).not.toBeNull()
    if (ready.digest === null) throw Error('Strict episode is not ready')
    if (master === 'publication-disposal') {
      const controller = new AbortController()
      const plan = await readApprovedEpisodePlan(project, 1, 1048576, controller.signal)
      const capture = await renderer.capture(plan, controller.signal)
      if (capture.withPublication === undefined) throw Error('Strict capture has no publication guard')
      const entered = Promise.withResolvers<AbortSignal>(), gate = Promise.withResolvers<undefined>()
      const pending = capture.withPublication(controller.signal, async (signal) => {
        entered.resolve(signal)
        await gate.promise
        signal.throwIfAborted()
      })
      const rejected = expect(pending).rejects.toThrow()
      const active = await entered.promise
      let disposed = false
      const closing = renderer.dispose().then(() => { disposed = true })
      expect(active.aborted).toBe(true)
      await Promise.resolve()
      expect(disposed).toBe(false)
      gate.resolve(undefined)
      await rejected
      await closing
      expect(disposed).toBe(true)
      return
    }
    const input = { projectDir: project, episode: 1, digest: ready.digest }
    await episode.admitEpisode(input)
    let final = await episode.episodeStatus(input)
    await expect.poll(async () => { final = await episode.episodeStatus(input); return ['completed', 'failed', 'unknown'].includes(final.state) },
      { timeout: 120000, interval: 100 }).toBe(true)
    if (master === 'wrong-master') {
      expect(final.state).not.toBe('completed')
      expect(final.problem).toContain('整集原声与已核验的原音轨及时间线不符')
      expect(final.output).toBeUndefined()
      expect(await readdir(join(project, 'exports')).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
        throw error
      })).toEqual([])
      return
    }
    expect(final.state, JSON.stringify(final)).toBe('completed')
    expect(final.output).toBeDefined()
    if (final.output === undefined || final.execution === undefined || final.attempt === null) throw Error('Strict episode did not publish a recorded output')
    const descriptorPath = join(project, '.muse', 'episode-delivery', final.attempt, final.execution, 'stage', 'descriptor.json')
    const captured = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
      sourceClaim: { files: { originalPath: string; stagedPath: string; sha256: string }[] } }
    expect(captured).toMatchObject({ version: 4,
      sourceClaim: { sessionId: owner.agent.id }, sourceEvidence: { sessions: [{ sessionId: owner.agent.id }] } })
    for (const { binding } of owner.reviews) {
      for (const [path, hash] of [[binding.ocrPath, binding.ocrSha256], [binding.inspectionPath, binding.inspectionSha256]]) {
        const staged = captured.sourceClaim.files.find(file => file.originalPath === path)
        expect(staged).toBeDefined()
        if (staged === undefined) throw Error('Session cache evidence was not staged')
        expect(sha(await readFile(staged.stagedPath))).toBe(hash)
        expect(staged.sha256).toBe(hash)
      }
    }
    const pcm = join(f.root, 'strict-output.pcm')
    await execute(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-i', join(project, final.output.path),
      '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 's16le', pcm])
    const output = await readFile(pcm)
    const strength = (frequency: number): number => {
      let real = 0, imaginary = 0
      for (let index = 400; index < Math.min(output.length / 2, 7600); index += 1) {
        const sample = output.readInt16LE(index * 2), angle = 2 * Math.PI * frequency * index / 8000
        real += sample * Math.cos(angle); imaginary += sample * Math.sin(angle)
      }
      return Math.hypot(real, imaginary)
    }
    expect(strength(880)).toBeGreaterThan(10 * strength(440))
    expect(f.data.fetch).not.toHaveBeenCalled()
  }, 180000)

it.skipIf(!enabled)('refuses a strict episode whose separate audio lacks source review', async () => {
  const f = await fixture(false, 'legacy-manual-separate')
  await writeFile(join(f.data.project, 'project_config.json'), JSON.stringify({ jubian_script_id: 1,
    project_bible: { visual_medium: 'animation_3d', delivery: { width: 1440, height: 2560, fps: 60, require_source_review: true } } }))
  const host = await f.launchHost()
  expect((await host.closed).code, host.diagnostic()).toBe(1)
  expect(host.diagnostic()).toContain('缺少本集选源审核')
  expect(await readdir(join(f.data.project, 'exports')).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  })).toEqual([])
  expect(f.data.fetch).not.toHaveBeenCalled()
}, 180000)

it.skipIf(!enabled)('does not publish when the original subtitle clock changes after private staging', async () => {
  const f = await fixture(false, 'valid'), host = await f.launchHost(), active = await host.running()
  const stage = join(f.data.project, '.muse', 'episode-delivery', active.attempt, active.execution ?? '', 'stage')
  await expect.poll(async () => {
    try { await readFile(join(stage, 'descriptor.json')); return true }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error }
  }, { timeout: 30000, interval: 10 }).toBe(true)
  await writeFile(join(f.data.project, 'editing', 'subtitle.srt.clock.json'), JSON.stringify({ version: 1,
    srt_sha256: '0'.repeat(64), source_clock_sha256: '0'.repeat(64) }))
  expect((await host.closed).code, host.diagnostic()).toBe(1)
  const result = JSON.parse(await readFile(host.result, 'utf8')) as { status: { state: string } }
  expect(result.status.state).not.toBe('completed')
  expect(await readdir(join(f.data.project, 'exports')).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  })).toEqual([])
}, 180000)

it.skipIf(!enabled)('does not publish when the captured original master changes after staging', async () => {
  const f = await fixture(false, 'valid'), host = await f.launchHost(), active = await host.running()
  const stage = join(f.data.project, '.muse', 'episode-delivery', active.attempt, active.execution ?? '', 'stage')
  await expect.poll(async () => {
    try { await readFile(join(stage, 'descriptor.json')); return true }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error }
  }, { timeout: 30000, interval: 10 }).toBe(true)
  await writeFile(join(f.data.project, 'audio', '01.wav'), 'changed-master')
  expect((await host.closed).code, host.diagnostic()).toBe(1)
  const result = JSON.parse(await readFile(host.result, 'utf8')) as { status: { state: string } }
  expect(result.status.state).not.toBe('completed')
  expect(await readdir(join(f.data.project, 'exports')).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  })).toEqual([])
}, 180000)

it.skipIf(!enabled)('does not publish when legacy selected audio changes after staging', async () => {
  const f = await fixture(false, 'legacy-manual-separate'), host = await f.launchHost(), active = await host.running()
  const stage = join(f.data.project, '.muse', 'episode-delivery', active.attempt, active.execution ?? '', 'stage')
  await expect.poll(async () => {
    try { await readFile(join(stage, 'descriptor.json')); return true }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error }
  }, { timeout: 30000, interval: 10 }).toBe(true)
  await writeFile(join(f.data.project, 'audio', 'source.wav'), 'changed-audio')
  expect((await host.closed).code, host.diagnostic()).toBe(1)
  const result = JSON.parse(await readFile(host.result, 'utf8')) as { status: { state: string } }
  expect(result.status.state).not.toBe('completed')
  expect(await readdir(join(f.data.project, 'exports')).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  })).toEqual([])
}, 180000)

it.skipIf(!enabled)('does not publish when an unbound subtitle gains a clock after staging', async () => {
  const f = await fixture(), host = await f.launchHost(), active = await host.running()
  const stage = join(f.data.project, '.muse', 'episode-delivery', active.attempt, active.execution ?? '', 'stage')
  await expect.poll(async () => {
    try { await readFile(join(stage, 'descriptor.json')); return true }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error }
  }, { timeout: 30000, interval: 10 }).toBe(true)
  await writeFile(join(f.data.project, 'editing', 'subtitle.srt.clock.json'), JSON.stringify({ version: 1,
    srt_sha256: '0'.repeat(64), source_clock_sha256: '0'.repeat(64) }))
  expect((await host.closed).code, host.diagnostic()).toBe(1)
  const result = JSON.parse(await readFile(host.result, 'utf8')) as { status: { state: string } }
  expect(result.status.state).not.toBe('completed')
  expect(await readdir(join(f.data.project, 'exports')).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  })).toEqual([])
}, 180000)

it.skipIf(!enabled)('rejects a stale generated subtitle clock before publishing an episode', async () => {
  const f = await fixture(false, 'stale'), host = await f.launchHost()
  expect(await host.closed, host.diagnostic()).toEqual({ code: 1, signal: null })
  expect(host.diagnostic()).toContain('生成字幕与当前集')
  expect(await readdir(join(f.data.project, 'exports')).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  })).toEqual([])
}, 180000)

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

it.skipIf(!enabled).each(['none', 'valid'] as const)(
  'drains real media after Host death and resumes the original attempt with clock=%s', async (clock) => {
    const f = await fixture(false, clock), host = await f.launchHost(), active = await host.running()
    const attemptRoot = join(f.data.project, '.muse', 'episode-delivery', active.attempt)
    const stage = join(attemptRoot, active.execution ?? '', 'stage')
    const owned: { guardian?: number; media?: number } = {}
    onTestFinished(async () => {
      for (const pid of [owned.guardian, owned.media]) {
        if (pid === undefined || !alive(pid)) continue
        let command: string
        try { command = (await execute('ps', ['-p', String(pid), '-o', 'command='])).stdout }
        catch (error) { if (error instanceof Error && 'code' in error && error.code === 1) continue; throw error }
        if (!command.includes(stage)) throw new Error('Refusing to signal PID without the owned execution path')
        process.kill(pid, 'SIGTERM')
        await expect.poll(() => alive(pid), { timeout: 30000 }).toBe(false)
      }
    })
    await expect.poll(async () => {
      const processes = (await execute('ps', ['-axo', 'pid=,command='])).stdout
      const row = processes.split('\n').find(line => line.includes(stage) && line.includes(ffmpeg ?? '') && line.includes('-i'))
      if (row !== undefined) owned.media = Number.parseInt(row.trim(), 10)
      return owned.media
    }, { timeout: 30000, interval: 10 }).toBeDefined()
    const running = z.object({ guardianPid: z.number().int().positive(), identity: z.object({ execution: z.string() }) })
      .parse(JSON.parse(await readFile(join(attemptRoot, 'execution.json'), 'utf8')))
    expect(running.identity.execution).toBe(active.execution)
    const guardian = running.guardianPid; owned.guardian = guardian
    host.child.kill('SIGKILL')
    expect(await host.closed).toEqual({ code: null, signal: 'SIGKILL' })
    let proof: unknown
    await expect.poll(async () => {
      try { proof = JSON.parse(await readFile(join(attemptRoot, `drained-${active.execution}.json`), 'utf8')); return true }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error }
    }, { timeout: 30000 }).toBe(true)
    expect(proof).toMatchObject({ result: 'cancelled', guardianPid: guardian, identity: { attempt: active.attempt, execution: active.execution } })
    await expect.poll(() => owned.media === undefined || !alive(owned.media), { timeout: 30000 }).toBe(true)
    await expect.poll(() => !alive(guardian), { timeout: 30000 }).toBe(true)
    const restored = await completed(f, await f.launchHost(true))
    expect(restored.status.attempt).toBe(active.attempt)
    expect(restored.status.execution).not.toBe(active.execution)
    console.info(JSON.stringify({ kind: 'actual-episode-host-death-resume', original: active, proof, resumed: restored.status }))
  }, 180000)

it.skipIf(!enabled)('rejects changed captured font bytes in the real worker before arming or spawning media', async () => {
  const f = await fixture(true), host = await f.launchHost()
  expect(await host.closed, host.diagnostic()).toEqual({ code: 1, signal: null })
  const result = z.object({ fetchCalls: z.literal(0), admitted: z.object({ attempt: z.string(), digest: z.string() }),
    status: z.object({ state: z.literal('failed'), execution: z.string(), problem: z.string() }) })
    .parse(JSON.parse(await readFile(host.result, 'utf8')))
  expect(result.status.problem).toContain('Episode staged or runtime file changed: staged')
  expect(result.status.problem).toContain('NotoSansCJKsc-Regular.otf')
  expect(result.status.problem).toContain('sha256/bytes mismatch')
  const attemptRoot = join(f.data.project, '.muse', 'episode-delivery', result.admitted.attempt)
  const stage = join(attemptRoot, result.status.execution, 'stage')
  expect(JSON.parse(await readFile(join(stage, 'media-spawn-witness.json'), 'utf8'))).toEqual({ calls: 0 })
  const job = z.object({ armedExecutions: z.array(z.string()), executionRef: z.null() })
    .parse(JSON.parse(await readFile(join(attemptRoot, 'job.json'), 'utf8')))
  expect(job.armedExecutions).toEqual([])
  expect(job.executionRef).toBeNull()
  for (const path of [join(attemptRoot, 'execution.json'), join(attemptRoot, `drained-${result.status.execution}.json`),
    join(stage, 'candidate-facts.json'), join(stage, 'exports', '01.mp4')]) {
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  }
  await expect(readFile(join(attemptRoot, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(f.data.project, 'exports', `Muse-episode-01-${result.admitted.digest}.mp4`)))
    .rejects.toMatchObject({ code: 'ENOENT' })
}, 180000)

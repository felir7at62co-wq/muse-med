/** Source-bound listening through actual local media and a controlled audio transport. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ProviderRequestId, type AudioReviewRoute, type AudioReviewTransport } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ShotScript from '@deepseek-ai/dsh-tool-shot-script'
import Tools from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { prepareContentListeningAudio } from '../src/content-listening-audio.ts'
import { encodeListeningReceipt, readContentListeningAttempt, reviewContentListening } from '../src/content-listening-review.ts'
import { createMediaToolkit } from '../src/ffmpeg.ts'
import { sourceRecordPathFor, writeSourceRecord } from '../src/source-record.ts'
import { createMediaRunner, ffmpeg, ffprobe, hasFfmpeg } from './audio-ffmpeg-harness.ts'

it('keeps a complete saved candidate inside the same byte budget as status readback', () => {
  const identity = 'a'.repeat(64)
  const receipt = { identity, listening_verified: false, grants_approval: false, assessment: { findings: [] } }
  expect(JSON.parse(encodeListeningReceipt(receipt))).toEqual(receipt)
  expect(() => encodeListeningReceipt({ ...receipt, assessment: { text: '验'.repeat(44_000) } }))
    .toThrow('听校回执超过可读取的大小')
})
const receiptBoundary = vi.hoisted(() => ({
  afterAttempt: undefined as (() => void) | undefined,
  beforeRead: undefined as ((path: string) => Promise<void>) | undefined,
  allocationError: undefined as Error | undefined,
  saveError: undefined as Error | undefined,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    async mkdir(...args: Parameters<typeof actual.mkdir>) {
      if (receiptBoundary.allocationError !== undefined && typeof args[0] === 'string'
        && basename(dirname(args[0])) === 'content-listening-reviews') throw receiptBoundary.allocationError
      return await actual.mkdir(...args)
    },
    async readFile(...args: Parameters<typeof actual.readFile>) {
      if (typeof args[0] === 'string') await receiptBoundary.beforeRead?.(args[0])
      return await actual.readFile(...args)
    },
    async writeFile(...args: Parameters<typeof actual.writeFile>) {
      if (receiptBoundary.saveError !== undefined && typeof args[0] === 'string'
        && basename(args[0]).startsWith('provider-response.json.')) throw receiptBoundary.saveError
      await actual.writeFile(...args)
      if (typeof args[0] === 'string' && basename(args[0]) === 'attempt.json') receiptBoundary.afterAttempt?.()
    },
  }
})

async function fixture(withRegisteredVoice = false, duration = 0.5, referenceDuration = 1) {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'dsh-listen-candidate-')))
  const runner = createMediaRunner()
  onTestFinished(async () => {
    receiptBoundary.afterAttempt = undefined
    receiptBoundary.beforeRead = undefined
    receiptBoundary.allocationError = undefined
    receiptBoundary.saveError = undefined
    await runner.dispose()
    await rm(project, { recursive: true, force: true })
  })
  const output = join(project, 'rendered.mp4')
  const subtitleSrt = join(project, 'display.srt')
  const authoredDialoguePath = join(project, 'authored.json')
  const toolkit = createMediaToolkit({ ffmpeg, ffprobe, channel: { run: runner.runCommand } })
  const encoded = await runner.runCommand(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
    `color=black:s=24x24:r=24:d=${String(duration)}`, '-f', 'lavfi', '-i',
    `aevalsrc=0.05*sin(2*PI*440*t)|0.08*sin(2*PI*550*t):s=48000:d=${String(duration)}:c=stereo`,
    '-c:v', 'mpeg4', '-c:a', 'aac', output])
  expect(encoded.code, encoded.stderr).toBe(0)
  await writeFile(subtitleSrt, '1\n00:00:00,010 --> 00:00:00,400\n你好\n')
  const speaking = { shot: 1, lines: ['你好'] }
  const shots = withRegisteredVoice ? [{ shot: 2, lines: [] }, speaking] : [speaking]
  const authored = JSON.stringify({ schema_version: 1, shots })
  await writeFile(authoredDialoguePath, authored)
  const outputSha = await fileSha256(output)
  const authoredSha = await fileSha256(authoredDialoguePath)
  const episode = '21'
  const inputFiles = [{ path: authoredDialoguePath, sha256: authoredSha }]
  const voiceContext = withRegisteredVoice ? await writeVoiceFixture(project, episode, runner, inputFiles, referenceDuration) : undefined
  await writeSourceRecord(sourceRecordPathFor(output), {
    version: 1, episode, rendered_at: new Date(0).toISOString(),
    output: { path: output, sha256: outputSha, size_bytes: (await stat(output)).size, duration_seconds: duration },
    inputs: [authoredSha], encoder: 'mpeg4', checks: [],
    input_files: inputFiles,
    delivery_inputs: { timeline_sha256: outputSha, subtitle_sha256: await fileSha256(subtitleSrt),
      master_audio_sha256: outputSha, videos: shots.map(row => row.shot).sort((left, right) => left - right)
        .map(shot => ({ shot, sha256: outputSha })) },
  })
  const base = { project, episode, output, toolkit }
  const prepared = await prepareContentListeningAudio(base)
  const input = { ...base, subtitleSrt, authoredDialoguePath, preparationPath: prepared.receipt_path }
  return { project, outputSha, authoredDialoguePath, authored, base, input, prepared, voiceContext }
}

async function writeVoiceFixture(project: string, episode: string, runner: ReturnType<typeof createMediaRunner>,
  inputFiles: { path: string; sha256: string }[], referenceDuration: number) {
  const scriptPath = join(project, 'script.md'), configPath = join(project, 'project_config.json')
  const directory = join(project, 'episode_packages', episode)
  const voicePath = join(project, 'voice.wav')
  const voice = await runner.runCommand(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
    `sine=frequency=720:sample_rate=48000:duration=${String(referenceDuration)}`, '-ac', '2', '-c:a', 'pcm_s16le', voicePath])
  expect(voice.code, voice.stderr).toBe(0)
  const voiceSha = await fileSha256(voicePath)
  const script = ['【镜头1】\n画面：房间。\n主体状态追踪：\n台词：甲：你好\n发声类型：dialogue',
    '【镜头2】\n画面：空房。\n发声类型：action', '【镜头3】\n画面：窗边。\n发声类型：action'].join('\n\n')
  const hash = (content: string) => createHash('sha256').update(content).digest('hex')
  const manifest = JSON.stringify({ version: 1, kind: 'muse_production', script_id: 17, episode,
    source_sha256: hash(script), video_tasks: [{ index: 1, shots: [1, 2] }, { index: 2, shots: [3] }] })
  const manifestPath = join(directory, `production-${hash(manifest)}.json`)
  const config = JSON.stringify({ jubian_script_id: 17, project_bible: { characters: [{ character_id: 'speaker-one', name: '甲',
    voice_profile: { reference_audio: 'https://example.invalid/voice.wav', reference_audio_asset_id: 11,
      reference_audio_sha256: voiceSha, reference_audio_duration_seconds: referenceDuration } }] } })
  await mkdir(directory, { recursive: true })
  await Promise.all([writeFile(scriptPath, script), writeFile(configPath, config), writeFile(manifestPath, manifest)])
  inputFiles.push({ path: configPath, sha256: hash(config) }, { path: manifestPath, sha256: hash(manifest) })
  return { source_script: scriptPath, references: [{ character_id: 'speaker-one', asset_id: 11, path: voicePath }] }
}

async function loadShotParser() {
  const context = new Context()
  onTestFinished(async () => { await context.fiber.dispose() })
  await context.plugin(SystemPrompt)
  await context.plugin(Tools)
  await context.plugin(ShotScript)
  const parse = context.get('shotScriptVoice')
  if (parse === undefined) throw new Error('Native shot-script parser unavailable')
  return parse
}

it.skipIf(!hasFfmpeg)('uses current native media once and never converts pending notes into approval', async () => {
  const { project, outputSha, authoredDialoguePath, authored, base, input } = await fixture()
  await expect(reviewContentListening(input)).rejects.toMatchObject({ code: 'CONTENT_LISTENING_ROUTE_UNAVAILABLE' })
  const route = { provider: 'review-fixture', model: 'qualified-audio-fixture' }
  let routes: AudioReviewRoute[] = [route, { provider: 'second-fixture', model: 'other' }]
  const request = vi.fn<AudioReviewTransport['request']>(async (args) => {
    const audio = args.wav[0]
    expect(audio?.subarray(0, 4).toString()).toBe('RIFF')
    expect(args.prompt).toContain('你好')
    const ids = args.wav.map(wav => createHash('sha256').update(wav).digest('hex'))
    const ok = { status: 'ok', reason: '样例语音检测完成。' }
    return { ...route, audioSha256: ids, listeningVerified: false, grantsApproval: false,
      requestId: ProviderRequestId('fixture-audio-1'), usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      response: { ranges: [{ start_us: 0, end_us: 500_000, reason: '记录完整音频范围。' }],
        assessments: { pronunciation: ok, dialogue_completeness: ok, speaker: ok, continuity: ok }, findings: [] } }
  })
  const transport = { configuredRoutes: () => routes, request }
  await expect(reviewContentListening({ ...input, transport })).rejects.toMatchObject({ code: 'CONTENT_LISTENING_ROUTE_UNAVAILABLE' })
  routes = [route]
  await writeFile(authoredDialoguePath, authored.replace('你好', '再见'))
  await expect(reviewContentListening({ ...input, transport })).rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_INPUT' })
  expect(request).not.toHaveBeenCalled()
  await writeFile(authoredDialoguePath, authored)
  const results = await Promise.allSettled([reviewContentListening({ ...input, transport }),
    reviewContentListening({ ...input, transport })])
  expect(request).toHaveBeenCalledTimes(1)
  const settled = results.find(result => result.status === 'fulfilled')
  if (settled === undefined) throw Error(JSON.stringify(results))
  expect(settled.value).toMatchObject({ status: 'needs_review', listening_verified: false, grants_approval: false,
    source_sha256: outputSha, findings_count: 1, cost_status: 'pending_reconciliation' })
  const saved: unknown = JSON.parse(await readFile(settled.value.receipt_path, 'utf8'))
  expect(saved).toMatchObject({ provider_request_id: 'fixture-audio-1', token_usage: { totalTokens: 30 },
    assessment: { assessments: { speaker: { status: 'uncertain' } } } })
  const reopen = { ...base, attemptPath: settled.value.attempt_path }
  await expect(readContentListeningAttempt(reopen)).resolves.toMatchObject({ status: 'candidate_available',
    candidate_path: settled.value.receipt_path, provider_request_id: 'fixture-audio-1', token_usage: { totalTokens: 30 },
    cost_status: 'pending_reconciliation', listening_verified: false, grants_approval: false })
  await expect(readContentListeningAttempt({ ...reopen, episode: '22' })).rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_INPUT' })
  await writeFile(settled.value.receipt_path, 'not a valid receipt')
  await expect(reviewContentListening({ ...input, transport })).rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_PENDING' })
  await expect(readContentListeningAttempt(reopen)).resolves.toMatchObject({ status: 'response_received',
    invalid_candidate: true, provider_request_id: 'fixture-audio-1', listening_verified: false, grants_approval: false })
  expect(request).toHaveBeenCalledTimes(1)

  const unusableRoute = { ...route, model: 'unusable-audio-fixture' }
  const unusableRequest = vi.fn<AudioReviewTransport['request']>(async ({ wav, onProviderResponse }) => {
    await onProviderResponse?.({ ...unusableRoute, audioSha256: wav.map(bytes => createHash('sha256').update(bytes).digest('hex')),
      requestId: ProviderRequestId('fixture-unusable-2'), usage: { inputTokens: 10, outputTokens: 7, totalTokens: 17 } })
    throw Error('Provider sent unparseable content after responding')
  })
  const unusableTransport = { configuredRoutes: () => [unusableRoute], request: unusableRequest }
  const unusableInput = { ...input, transport: unusableTransport }
  await expect(reviewContentListening(unusableInput)).rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_PENDING' })
  const directory = join(project, 'audio', 'content-listening-reviews')
  const attemptPaths = (await readdir(directory)).map(entry => join(directory, entry, 'attempt.json'))
  const failedAttempt = attemptPaths.find(path => path !== settled.value.attempt_path)
  if (failedAttempt === undefined) throw Error('Missing original attempt after response rejection')
  await expect(readContentListeningAttempt({ ...base, attemptPath: failedAttempt })).resolves.toMatchObject({
    status: 'response_received', provider_request_id: 'fixture-unusable-2', token_usage: { totalTokens: 17 },
    cost_status: 'pending_reconciliation', listening_verified: false, grants_approval: false })
  await expect(reviewContentListening(unusableInput)).rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_PENDING' })
  expect(unusableRequest).toHaveBeenCalledTimes(1)
}, 20_000)

it.skipIf(!hasFfmpeg)('binds the native review and its accounting receipt to the registered role sample', async () => {
  const { base, input, prepared, voiceContext } = await fixture(true)
  if (voiceContext === undefined) throw new Error('Missing registered voice fixture')
  const parseVoiceScript = await loadShotParser()
  const sample = voiceContext.references[0]
  if (sample === undefined) throw new Error('Registered role has no test sample')
  const sampleSha = await fileSha256(sample.path)
  const route = { provider: 'native-fixture', model: 'registered-voice' }
  const request = vi.fn<AudioReviewTransport['request']>(async ({ wav, prompt }) => {
    const hashes = wav.map(bytes => createHash('sha256').update(bytes).digest('hex'))
    expect(hashes).toEqual([prepared.wav_sha256, sampleSha])
    expect(prompt).toContain('按镜号和 reference_attachment 对照后续批准声线样本')
    expect(prompt).toContain('"character_id":"speaker-one","reference_attachment":2')
    expect(prompt).toContain('"render_shot":1,"line_index":1')
    expect(prompt).toContain('"shots":[{"shot":1,"lines":["你好"]},{"shot":2,"lines":[]}]')
    const ok = { status: 'ok', reason: '完整覆盖该维度。' }
    return { ...route, audioSha256: hashes, listeningVerified: false, grantsApproval: false,
      usage: { inputTokens: 13, outputTokens: 7, totalTokens: 20 },
      response: { ranges: [{ start_us: 0, end_us: prepared.duration_us, reason: '记录完整音频。' }],
        assessments: { pronunciation: ok, dialogue_completeness: ok, speaker: ok, continuity: ok }, findings: [] } }
  })
  const options = { ...input, parseVoiceScript, voiceContext, transport: { configuredRoutes: () => [route], request } }
  await expect(reviewContentListening({ ...options, mode: 'blind_dialogue' }))
    .rejects.toThrow('盲听对白时请勿同时提供角色声音样本')
  expect(request).not.toHaveBeenCalled()
  const result = await reviewContentListening(options)
  expect(result).toMatchObject({ voice_reference_count: 1, findings_count: 0, listening_verified: false, grants_approval: false })
  const saved: unknown = JSON.parse(await readFile(result.receipt_path, 'utf8'))
  expect(saved).toMatchObject({ assessment: { assessments: { speaker: { status: 'ok' } } }, voice_context: {
    clip_mapping: [{ render_shot: 1, source_shots: [1, 2] }, { render_shot: 2, source_shots: [3] }],
    references: [{ asset_id: 11, wav_sha256: sampleSha }],
  } })
  const recovered = await readContentListeningAttempt({ ...base, attemptPath: result.attempt_path })
  expect(recovered).toMatchObject({ status: 'candidate_available', token_usage: { totalTokens: 20 }, cost_status: 'pending_reconciliation' })
  expect(recovered).not.toHaveProperty('provider_request_id')

  const identity = dirname(result.attempt_path)
  const redirected = join(base.project, 'substituted-identity')
  await mkdir(redirected)
  await rm(identity, { recursive: true })
  await symlink(redirected, identity, 'junction')
  await expect(reviewContentListening(options)).rejects.toThrow('本次听校目录发生重定向')
  expect(await readdir(redirected)).toEqual([])
  expect(request).toHaveBeenCalledOnce()
}, 20_000)

it.skipIf(!hasFfmpeg).each([
  ['reference byte budget', 120, 6, '整集音轨超出听校线路容量'],
  ['invalid derived PCM', 46, 1, '整集试听轨不是当前完整、可发送的 PCM WAV'],
] as const)('refuses to dispatch registered voice review with %s', async (scenario, duration, referenceDuration, expected) => {
  const { project, input, prepared, voiceContext } = await fixture(true, duration, referenceDuration)
  if (voiceContext === undefined) throw new Error('Missing registered voice fixture')
  const parseVoiceScript = await loadShotParser()
  const route = { provider: 'native-fixture', model: 'bounded-voices' }
  const request = vi.fn<AudioReviewTransport['request']>()
  let converted: string | undefined
  const { toolkit } = input
  const channel = { run: async (binary: string, args: readonly string[]) => {
    const result = await toolkit.channel.run(binary, args)
    const path = args.at(-1)
    if (scenario !== 'invalid derived PCM' || binary !== ffprobe || path === undefined || basename(path) !== 'provider.wav') return result
    converted = path
    const bytes = await readFile(path)
    const format = bytes.indexOf('fmt ', 12, 'ascii')
    if (format < 0) throw new Error('Native conversion did not generate a WAV format chunk')
    // Model the temporary file changing after the successful probe, preserving the outer RIFF shape.
    bytes.writeUInt16LE(3, format + 8)
    await writeFile(path, bytes)
    return result
  } }
  const task = reviewContentListening({ ...input, toolkit: { ...toolkit, channel }, parseVoiceScript, voiceContext,
    transport: { configuredRoutes: () => [route], request } })
  await expect(task).rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_INPUT' })
  await expect(task).rejects.toThrow(expected)
  expect(request).not.toHaveBeenCalled()
  await expect(stat(join(project, 'audio', 'content-listening-reviews'))).rejects.toMatchObject({ code: 'ENOENT' })
  if (scenario === 'invalid derived PCM') {
    if (converted === undefined) throw new Error('Expected the native WAV to be verified after conversion')
    await expect(stat(dirname(converted))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  expect(await fileSha256(prepared.wav_path)).toBe(prepared.wav_sha256)
}, 45_000)

it.skipIf(!hasFfmpeg)('rejects substituted preparation receipts and redirected review output without dispatch', async () => {
  const { project, input } = await fixture()
  const route = { provider: 'native-fixture', model: 'unsafe-directory' }
  const request = vi.fn<AudioReviewTransport['request']>()
  const options = { ...input, transport: { configuredRoutes: () => [route], request } }
  const copy = join(project, 'copy-of-preparation.json')
  await writeFile(copy, Buffer.alloc(129 * 1024, 0x20))
  await expect(reviewContentListening({ ...options, preparationPath: copy })).rejects.toThrow('大小上限的本次回执文件')
  await writeFile(copy, await readFile(input.preparationPath))
  await expect(reviewContentListening({ ...options, preparationPath: copy })).rejects.toThrow('对应的试听准备回执')
  receiptBoundary.beforeRead = async (path) => {
    if (path === copy) await writeFile(path, Buffer.alloc(129 * 1024, 0x20))
  }
  await expect(reviewContentListening({ ...options, preparationPath: copy })).rejects.toThrow('听校回执超过可读取的大小')
  receiptBoundary.beforeRead = undefined
  const storageFull = Object.assign(new Error('review storage full'), { code: 'ENOSPC' })
  receiptBoundary.allocationError = storageFull
  await expect(reviewContentListening(options)).rejects.toBe(storageFull)
  receiptBoundary.allocationError = undefined
  await rm(join(project, 'audio', 'content-listening-reviews'), { recursive: true })
  const redirected = join(project, 'redirected-reviews')
  await mkdir(redirected)
  await symlink(redirected, join(project, 'audio', 'content-listening-reviews'), 'junction')
  await expect(reviewContentListening(options)).rejects.toThrow('听校结果目录发生重定向')
  expect(await readdir(redirected)).toEqual([])
  expect(request).not.toHaveBeenCalled()
}, 20_000)

it.skipIf(!hasFfmpeg)('removes an aborted pre-dispatch reservation and can safely build a fresh blind candidate', async () => {
  const { project, base, input } = await fixture()
  const reviewRoot = join(project, 'audio', 'content-listening-reviews')
  const route = { provider: 'native-fixture', model: 'blind-local' }
  const request = vi.fn<AudioReviewTransport['request']>(async ({ wav, prompt }) => {
    expect(prompt).not.toContain('你好')
    return { ...route, audioSha256: wav.map(bytes => createHash('sha256').update(bytes).digest('hex')),
      listeningVerified: false, grantsApproval: false,
      response: { ranges: [{ start_us: 0, end_us: 500_000, status: 'reviewed' }],
        utterances: [{ start_us: 10_000, end_us: 400_000, text: '你好' }] } }
  })
  const options = { ...input, mode: 'blind_dialogue' as const, transport: { configuredRoutes: () => [route], request } }
  const controller = new AbortController(), reason = new Error('cancelled before sending the audio')
  receiptBoundary.afterAttempt = () => { controller.abort(reason) }
  try {
    await expect(reviewContentListening({ ...options, signal: controller.signal })).rejects.toBe(reason)
    expect(request).not.toHaveBeenCalled()
    expect(await readdir(reviewRoot)).toEqual([])
  } finally {
    receiptBoundary.afterAttempt = undefined
  }
  const success = await reviewContentListening(options)
  expect(success).toMatchObject({ mode: 'blind_dialogue', listening_verified: false, grants_approval: false })
  const recovered = await readContentListeningAttempt({ ...base, attemptPath: success.attempt_path })
  expect(recovered).toMatchObject({ status: 'candidate_available', candidate_path: success.receipt_path,
    cost_status: 'pending_reconciliation' })
  expect(recovered).not.toHaveProperty('provider_response_path')
  const renamed = join(dirname(success.attempt_path), 'copy-of-attempt.json')
  await writeFile(renamed, await readFile(success.attempt_path))
  await expect(readContentListeningAttempt({ ...base, attemptPath: renamed }))
    .rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_INPUT' })
  expect(request).toHaveBeenCalledOnce()
}, 20_000)

it.skipIf(!hasFfmpeg).each(['cancelled', 'receipt could not be saved'] as const)(
  'keeps a single unresolved dispatch when %s', async (outcome) => {
    const { project, base, input } = await fixture()
    const route = { provider: 'native-fixture', model: 'pending-local' }
    const controller = new AbortController()
    const cancelled = new Error('cancelled after dispatch started')
    const request = vi.fn<AudioReviewTransport['request']>(async ({ signal, wav, onProviderResponse }) => {
      expect(signal).toBe(controller.signal)
      if (outcome === 'cancelled') controller.abort(cancelled)
      else {
        receiptBoundary.saveError = cancelled
        await onProviderResponse?.({ ...route, audioSha256: wav.map(bytes => createHash('sha256').update(bytes).digest('hex')),
          requestId: ProviderRequestId('unrecorded-provider-response') })
      }
      throw cancelled
    })
    const transport = { configuredRoutes: () => [route], request }
    const task = reviewContentListening({ ...input, transport, signal: controller.signal })
    if (outcome === 'cancelled') await expect(task).rejects.toBe(cancelled)
    else await expect(task).rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_PENDING', cause: cancelled })
    const directory = join(project, 'audio', 'content-listening-reviews')
    const [identity] = await readdir(directory)
    if (identity === undefined) throw new Error('Dispatch must retain its original attempt')
    const attemptPath = join(directory, identity, 'attempt.json')
    await expect(readContentListeningAttempt({ ...base, attemptPath })).resolves.toMatchObject({
      status: 'pending_provider', cost_status: 'pending_reconciliation', listening_verified: false, grants_approval: false,
    })
    await expect(reviewContentListening({ ...input, transport })).rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_PENDING' })
    expect(request).toHaveBeenCalledOnce()
    expect(await readdir(dirname(attemptPath))).toEqual(['attempt.json'])
  }, 20_000)

it.skipIf(!hasFfmpeg).each(['different reply hash', 'changed subtitle'] as const)(
  'retains the exact original attempt without a candidate after %s', async (outcome) => {
    const { project, base, input, outputSha } = await fixture()
    const originalSubtitle = await readFile(input.subtitleSrt)
    const route = { provider: 'native-fixture', model: 'bound-local' }
    const request = vi.fn<AudioReviewTransport['request']>(async ({ wav }) => {
      if (outcome === 'changed subtitle') await writeFile(input.subtitleSrt, 'changed after dispatch')
      const hashes = wav.map(bytes => createHash('sha256').update(bytes).digest('hex'))
      return { ...route, audioSha256: outcome === 'different reply hash' ? ['a'.repeat(64)] : hashes,
        requestId: ProviderRequestId('bound-audio'), listeningVerified: false, grantsApproval: false, response: {} }
    })
    const transport = { configuredRoutes: () => [route], request }
    await expect(reviewContentListening({ ...input, transport })).rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_INPUT' })
    const directory = join(project, 'audio', 'content-listening-reviews')
    const [identity] = await readdir(directory)
    if (identity === undefined) throw new Error('Missing reserved attempt')
    const attemptPath = join(directory, identity, 'attempt.json')
    const saved = await readContentListeningAttempt({ ...base, attemptPath })
    expect(saved.status).toBe(outcome === 'different reply hash' ? 'pending_provider' : 'response_received')
    if (outcome === 'changed subtitle') {
      expect(saved.provider_request_id).toBe('bound-audio')
      const file = saved.provider_response_path
      if (file === undefined) throw new Error('Missing received-provider proof')
      const receipt: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (receipt === null || typeof receipt !== 'object') throw new Error('Invalid fixture receipt')
      await writeFile(file, JSON.stringify({ ...receipt, provider: 'another-provider' }))
      await expect(readContentListeningAttempt({ ...base, attemptPath }))
        .rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_INPUT' })
    }
    expect(saved).not.toHaveProperty('candidate_path')
    await writeFile(input.subtitleSrt, originalSubtitle)
    await expect(reviewContentListening({ ...input, transport })).rejects.toMatchObject({ code: 'CONTENT_LISTENING_REVIEW_PENDING' })
    expect(request).toHaveBeenCalledOnce()
    expect(await fileSha256(input.output)).toBe(outputSha)
  }, 20_000)

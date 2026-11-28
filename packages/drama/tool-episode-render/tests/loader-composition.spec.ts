/** Public render arguments through a Loader-owned tool registration. */
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import { fileSha256 } from '../src/cache.ts'
import type { DramaRenderReport } from '../src/types.ts'
import * as Render from '../src/index.ts'
import * as Media from '../src/ffmpeg.ts'
import { createMediaRunner, ffmpeg, ffprobe, hasFfmpeg } from './audio-ffmpeg-harness.ts'
import * as AudioReview from '../src/content-listening-review.ts'
import * as AudioPreflight from '../src/content-listening-preflight.ts'
import * as ListeningAudio from '../src/content-listening-audio.ts'
import { cleanup, decodeHandler, framemd5Line, placeholderHandler, probeHandler, probeJson, renderedPictureProbe, runContext,
  seekHandler, shippedEndingAsset, stubChannel, tempProject, writePlaceholder } from './harness.ts'

/** Load the real renderer contribution through a private test-only Cordis config. */
async function loadRenderer(ctx: Context, root: string, enableAudioTools = false): Promise<void> {
  const config = join(root, 'cordis.yml')
  await writeFile(config, [
    ...(ctx.get('systemPrompt') === undefined ? ["- name: '@deepseek-ai/dsh-system-prompt'"] : []),
    ...(ctx.get('tools') === undefined ? ["- name: '@deepseek-ai/dsh-tools'"] : []),
    "- name: '@deepseek-ai/dsh-tool-episode-render'",
    '  config:',
    '    preferNvenc: false',
    ...(enableAudioTools ? ['    enableContentListeningReview: true', '    enableLocalDialoguePatch: true'] : []),
    '',
  ].join('\n'))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', Tools],
    ['@deepseek-ai/dsh-tool-episode-render', Render],
  ])
  ctx.loader.internal = {
    version: 'v2', loadCache: new Map(),
    register() { throw new Error('Unexpected loader hooks') },
    getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
    resolveSync() { throw new Error('Unexpected loader resolution') },
    load() { throw new Error('Unexpected loader load') },
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected module: ${specifier}`)
      return modules.get(specifier)
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
}

/** Invoke the Loader-owned tool with public arguments and validate both schemas. */
async function invoke(tool: ToolDefinition, args: Record<string, unknown>) {
  expect(validateJsonSchemaValue(tool.parameters, args, '')).toEqual([])
  const result = await tool.execute(args, runContext())
  expect(validateJsonSchemaValue(tool.output.schema, result, '')).toEqual([])
  return result
}

/** Write one small 480p project whose media commands stay on the injected channel. */
async function writePreviewInputs(root: string): Promise<void> {
  await writePlaceholder(join(root, 'source.mp4'), 'selected source')
  await writePlaceholder(join(root, 'approved-bgm.wav'), 'selected pure music bed')
  await writePlaceholder(join(root, 'project_config.json'), JSON.stringify({ project_bible: {
    visual_medium: 'animation_3d', delivery: { width: 480, height: 854, fps: 24 } } }))
  await writePlaceholder(join(root, 'shots.json'), JSON.stringify({ shots: [{ shot: 1, video: 'source.mp4' }] }))
  await writePlaceholder(join(root, 'source.srt'), '1\n00:00:01,000 --> 00:00:02,000\n原文\n')
}

it('prepares strict source-review projects through the Loader without leaking policy flags into public preview geometry', async () => {
  const root = await tempProject()
  const ctx = new Context()
  const channel = stubChannel([
    probeHandler({ [join(root, 'source.mp4')]: { durationSeconds: 3, video: {}, audio: {} } }),
    placeholderHandler(),
  ])
  const mediaFactory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue(
    Media.createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
  )
  try {
    await writePreviewInputs(root)
    await writeFile(join(root, 'project_config.json'), JSON.stringify({ project_bible: {
      visual_medium: 'animation_3d', delivery: { width: 480, height: 854, fps: 24,
        min_bitrate_mbps: 8, max_effective_chars_per_shot: 80, require_source_review: true,
        subtitle: { require_no_punctuation: true, require_speech_coverage: true },
        audio: { require_music_decision: true },
      },
    } }))
    await loadRenderer(ctx, root)
    const tool = ctx.tools.get('drama_render')
    if (tool === undefined) throw new Error('missing Loader renderer')
    const report = await invoke(tool, { method: 'prepare', project: root, episode: 1,
      shots: 'shots.json', subtitle_srt: 'source.srt', bgm: 'approved-bgm.wav' }) as DramaRenderReport
    expect(report.render_preview?.delivery).toEqual({ visual_medium: 'animation_3d', width: 480, height: 854, fps: 24 })
    const timeline = JSON.parse(await readFile(join(root, 'editing', '01-timeline.json'), 'utf8')) as { delivery: unknown }
    expect(timeline.delivery).toMatchObject({ require_source_review: true,
      subtitle: { require_no_punctuation: true, require_speech_coverage: true }, audio: { require_music_decision: true } })
    const leaked = { ...report, render_preview: { ...report.render_preview,
      delivery: { ...report.render_preview?.delivery, require_source_review: true } } }
    expect(validateJsonSchemaValue(tool.output.schema, leaked, '').length).toBeGreaterThan(0)
  } finally {
    mediaFactory.mockRestore()
    await ctx.fiber.dispose()
    await cleanup(root)
  }
})

it.each([false, true])('only exposes the provisioned audio tools (enabled: %s) and preserves read-only sessions', async (enabled) => {
  const project = await tempProject(), ctx = new Context()
  const media = vi.spyOn(Media, 'createMediaToolkit')
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: project })
    const harness = await mountAgentLoopTestHarness(ctx)
    await loadRenderer(ctx, project, enabled)
    const toolNames = ['drama_review_audio', 'drama_patch_dialogue'] as const
    if (!enabled) {
      expect(toolNames.map(name => ctx.tools.get(name))).toEqual([undefined, undefined])
      return
    }
    await expect.poll(() => toolNames.map(name => ctx.tools.get(name)?.name)).toEqual([...toolNames])
    const [review, patch] = toolNames.map(name => ctx.tools.get(name))
    if (review === undefined || patch === undefined) throw new Error('Loader did not register opted-in audio tools')
    const agent = await harness.create(SessionId('episode-audio-permissions'), {}, { cwd: project })
    const exec = { ...runContext(), agent }
    const reviewArgs = { method: 'prepare', project, episode: 1, output: 'candidate.mp4' }
    const patchArgs = { project, episode: 1, target_evidence_id: '00000000-0000-4000-8000-000000000001',
      donor_evidence_id: '00000000-0000-4000-8000-000000000002',
      target_start_ms: 100, donor_start_ms: 100, duration_ms: 200 }
    const before = await readdir(project)
    await expect(review.execute(reviewArgs, runContext())).rejects.toThrow('当前 Muse 制作会话')
    await expect(patch.execute(patchArgs, runContext())).rejects.toThrow('普通 Muse 会话')
    await expect(review.execute(reviewArgs, exec)).rejects.toThrow('当前会话仅可读取')
    await expect(patch.execute(patchArgs, exec)).rejects.toThrow('仅可读取文件')
    agent.session.append('sandbox/mode', { mode: 'workspace-write' })
    await expect(patch.execute(patchArgs, exec)).rejects.toThrow('OFFLINE_PRONUNCIATION_SESSION')
    expect(await readdir(project)).toEqual(before)
    expect(media).not.toHaveBeenCalled()
  } finally {
    media.mockRestore()
    await ctx.fiber.dispose()
    await cleanup(project)
  }
})

it('routes an opted-in listening request with bounded local files and an explicitly provisioned transport', async () => {
  const project = await tempProject()
  const unrelated = await tempProject()
  const ctx = new Context()
  const prepare = vi.spyOn(ListeningAudio, 'prepareContentListeningAudio').mockResolvedValue({
    status: 'prepared_for_review', listening_verified: false, grants_approval: false,
    source_path: join(project, 'native.mp4'), source_sha256: 'a'.repeat(64), source_record_sha256: 'b'.repeat(64),
    wav_path: join(project, 'voice.wav'), wav_sha256: 'c'.repeat(64), pcm_sha256: 'd'.repeat(64),
    duration_us: 1_000_000, sample_count: 48000, sample_rate: 48000, channels: 2,
    receipt_path: join(project, 'prepare.json'),
  })
  const status = vi.spyOn(AudioReview, 'readContentListeningAttempt').mockResolvedValue({
    status: 'pending_provider', attempt_path: join(project, 'attempt.json'), source_sha256: 'a'.repeat(64),
    provider: 'fixture', model: 'fixture', cost_status: 'pending_reconciliation',
    listening_verified: false, grants_approval: false,
  })
  const preflight = vi.spyOn(AudioPreflight, 'preflightContentListening').mockRejectedValue(new Error('verified preflight route'))
  const review = vi.spyOn(AudioReview, 'reviewContentListening').mockResolvedValue({
    status: 'needs_review', mode: 'blind_dialogue', listening_verified: false, grants_approval: false,
    source_sha256: 'a'.repeat(64), audio_sha256: 'b'.repeat(64), duration_us: 1_000_000,
    provider: 'fixture', model: 'fixture', findings_count: 1, receipt_path: join(project, 'candidate.json'),
    attempt_path: join(project, 'attempt.json'), cost_status: 'pending_reconciliation',
  })
  const request = vi.fn()
  const transport = { configuredRoutes: () => [], request }
  const parseVoiceScript = vi.fn()
  try {
    const releaseTransport = ctx.provide('audioReviewTransport', transport)
    ctx.provide('shotScriptVoice', parseVoiceScript)
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: project })
    const harness = await mountAgentLoopTestHarness(ctx)
    await loadRenderer(ctx, project, true)
    await expect.poll(() => ctx.tools.get('drama_review_audio')?.name).toBe('drama_review_audio')
    const tool = ctx.tools.get('drama_review_audio')
    if (tool === undefined) throw new Error('Missing opted-in listening tool')
    const agent = await harness.create(SessionId('episode-listening-routing'), {}, { cwd: project })
    const exec = { ...runContext(), agent }
    for (const name of ['native.mp4', 'attempt.json', 'prepare.json', 'display.srt', 'script.txt', 'dialogue.json', 'voice.wav']) {
      await writeFile(join(project, name), name)
    }
    const args = { project, episode: 21, output: 'native.mp4' }
    await expect(tool.execute({ ...args, method: 'review_status' }, exec)).rejects.toThrow('原听校尝试记录')
    await expect(tool.execute({ ...args, method: 'review_status', attempt: 'attempt.json' }, exec))
      .resolves.toMatchObject({ status: 'pending_provider', listening_verified: false, grants_approval: false })
    expect(status).toHaveBeenCalledWith(expect.objectContaining({
      output: join(project, 'native.mp4'), attemptPath: join(project, 'attempt.json'), episode: '21',
    }))
    agent.session.append('sandbox/mode', { mode: 'workspace-write' })
    await expect(tool.execute({ ...args, method: 'prepare' }, exec))
      .resolves.toMatchObject({ status: 'prepared_for_review', listening_verified: false, grants_approval: false })
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ output: join(project, 'native.mp4') }))
    await expect(tool.execute({ ...args, episode: 0, method: 'preflight' }, exec)).rejects.toThrow('必须是正整数')
    await expect(tool.execute({ ...args, project: unrelated, method: 'preflight' }, exec)).rejects.toThrow('当前授权工作区')
    await expect(tool.execute({ ...args, output: '.', method: 'preflight' }, exec)).rejects.toThrow('实际存在的文件')
    await expect(tool.execute({ ...args, method: 'preflight', attempt: 'attempt.json' }, exec)).rejects.toThrow('仅用于 review_status')
    await expect(tool.execute({ ...args, method: 'preflight', preparation: 'prepare.json' }, exec)).rejects.toThrow('不需要听校配置')
    await expect(tool.execute({ ...args, method: 'preflight' }, exec)).rejects.toThrow('verified preflight route')
    await expect(tool.execute({ ...args, method: 'preflight', subtitle_srt: 'display.srt' }, exec)).rejects.toThrow('verified preflight route')
    expect(preflight.mock.calls[0]?.[0]).not.toHaveProperty('subtitleSrt')
    expect(preflight).toHaveBeenLastCalledWith(expect.objectContaining({ subtitleSrt: join(project, 'display.srt') }))
    expect(review).not.toHaveBeenCalled()
    const inputs = { ...args, method: 'review', preparation: 'prepare.json', subtitle_srt: 'display.srt', authored_dialogue: 'dialogue.json' }
    const voice_context = { source_script: 'script.txt', references: [{ character_id: 'speaker', asset_id: 12, path: 'voice.wav' }] }
    await expect(tool.execute({ ...inputs, mode: 'blind_dialogue', voice_context }, exec)).rejects.toThrow('盲听和声线上下文不能同用')
    await expect(tool.execute({ ...inputs, mode: 'blind_dialogue' }, exec))
      .resolves.toMatchObject({ status: 'needs_review', listening_verified: false, grants_approval: false })
    expect(review).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 'blind_dialogue', preparationPath: join(project, 'prepare.json'), transport,
    }))
    await expect(tool.execute({ ...inputs, voice_context }, exec)).resolves.toMatchObject({ status: 'needs_review' })
    expect(review).toHaveBeenLastCalledWith(expect.objectContaining({
      parseVoiceScript, voiceContext: { source_script: join(project, 'script.txt'),
        references: [{ character_id: 'speaker', asset_id: 12, path: join(project, 'voice.wav') }] },
    }))
    expect(request).not.toHaveBeenCalled()
    releaseTransport()
    await expect(tool.execute(inputs, exec)).resolves.toMatchObject({ status: 'needs_review' })
    expect(review.mock.lastCall?.[0]).not.toHaveProperty('transport')
  } finally {
    prepare.mockRestore()
    status.mockRestore()
    preflight.mockRestore()
    review.mockRestore()
    await ctx.fiber.dispose()
    await Promise.all([cleanup(project), cleanup(unrelated)])
  }
})

it.skipIf(!hasFfmpeg)('uses current native pronunciation receipts to produce a bounded local dialogue candidate', async () => {
  const root = await realpath(await tempProject())
  const project = join(root, 'episode')
  const target = join(project, 'target.mp4'), donor = join(project, 'donor.mp4')
  const ctx = new Context()
  const runner = createMediaRunner()
  const media = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue({ ffmpeg, ffprobe, channel: runner.channel })
  try {
    await mkdir(project)
    for (const [path, frequency] of [[target, 337], [donor, 833]] as const) {
      const encoded = await runner.runCommand(ffmpeg, ['-n', '-v', 'error', '-f', 'lavfi', '-i',
        'testsrc2=size=128x96:rate=24:duration=3', '-f', 'lavfi', '-i',
        `sine=frequency=${frequency}:sample_rate=32000:duration=3`, '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', path])
      expect(encoded.code, encoded.stderr).toBe(0)
    }
    const source = { target: { path: target, sha256: await fileSha256(target) }, donor: { path: donor, sha256: await fileSha256(donor) } }
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: root })
    const harness = await mountAgentLoopTestHarness(ctx)
    await loadRenderer(ctx, root, true)
    await expect.poll(() => ctx.tools.get('drama_patch_dialogue')?.name).toBe('drama_patch_dialogue')
    const agent = await harness.create(SessionId('bound-dialogue-repair'), {}, { cwd: root })
    let nativeStep = 0
    const issue = (role: 'target' | 'donor', evidence = source[role], evidenceProject = project, neighbor = 'ding4') => {
      const evidenceId = randomUUID(), step = ++nativeStep, callId = ToolCallId(`pronunciation-${step}`)
      const isTarget = role === 'target', expected = 'dai4', alternative = 'zai4'
      const ranges = isTarget ? [{ start: 0.85, end: 2 }, { start: 0.9, end: 2.1 }]
        : [{ start: 0, end: 1 }, { start: 0.05, end: 1.1 }]
      const request = { tokens: ['wo3', expected, neighbor], target_index: 1, alternative, windows: ranges }
      const body = { offline_pronunciation: { version: 1, evidence_id: evidenceId, project: evidenceProject, source: evidence,
        model: { name: 'robinsonphan/sensevoice-small-zh-pinyin-dual-ctc', revision: '884e70660b97f9c242f1d77c8516aea62a8fdf29',
          sha256: 'ed3c7db2468b99fd3811578fff6000c990875c22b1e93abcd08f9c05bc61a93a' },
        status: isTarget ? 'suspected_mismatch' : 'matching_in_windows', expected, alternative, target_index: 1,
        windows: ranges.map(range => ({ ...range, observed: isTarget ? alternative : expected, target_seconds: isTarget ? 1.35 : 0.54,
          alternative_minus_expected: isTarget ? 12 : -12,
          pcm: { sha256: 'a'.repeat(64), sampleRate: 16000, samples: Math.round((range.end - range.start) * 16000) } })),
        minimum_margin: 8, listening_verified: false, note: 'synthetic local speech observations',
      } }
      agent.session.append('tool/call', { turn: 1, step, callId, name: 'audio_transcribe',
        arguments: JSON.stringify({ method: 'pronunciation', project: evidenceProject, input: evidence.path, pronunciation: request }) })
      agent.session.append('tool/result', { turn: 1, step,
        message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: JSON.stringify(body) }] }),
        meta: { [TOOL_BODY_META_KEY]: body } }, { surfaceOp: 'append' })
      return evidenceId
    }
    const args = { project, episode: 21, target_evidence_id: issue('target'), donor_evidence_id: issue('donor'),
      target_start_ms: 1250, donor_start_ms: 450, duration_ms: 240 }
    const invokePatch = (request: typeof args) => executeModelToolFixture(ctx, { name: 'drama_patch_dialogue',
      callId: ToolCallId(randomUUID()), arguments: request, signal: new AbortController().signal, agent })
    const unrelatedProjectReceipt = { ...args, donor_evidence_id: issue('donor', source.donor, root) }
    const refusals = [
      [{ ...args, donor_evidence_id: issue('donor', source.target) }, 'DIALOGUE_PATCH_EVIDENCE'],
      [{ ...args, donor_evidence_id: issue('donor', source.donor, project, 'ding1') }, 'DIALOGUE_PATCH_EVIDENCE'],
      [{ ...args, target_start_ms: 1600 }, 'DIALOGUE_PATCH_EVIDENCE'],
      [{ ...args, project: join(root, 'missing-project') }, '当前授权工作区'],
      [unrelatedProjectReceipt, 'DIALOGUE_PATCH_SOURCE'],
      [{ ...args, donor_evidence_id: issue('donor', { ...source.donor, path: join(project, 'missing-source.mp4') }) },
        'DIALOGUE_PATCH_SOURCE'],
    ] as const
    for (const [request, reason] of refusals) {
      const refused = await invokePatch(request)
      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain(reason)
    }
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    if (platform === undefined) throw new Error('Missing Node platform descriptor')
    try {
      // Exercise the other path comparison rule only during a denied metadata check.
      Object.defineProperty(process, 'platform', { ...platform, value: process.platform === 'win32' ? 'linux' : 'win32' })
      const refused = await invokePatch(unrelatedProjectReceipt)
      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain('DIALOGUE_PATCH_SOURCE')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
    expect(media).not.toHaveBeenCalled()
    expect((await readdir(project)).sort()).toEqual(['donor.mp4', 'target.mp4'])

    const repaired = await invokePatch(args)
    expect(repaired.isError, JSON.stringify(repaired.content)).toBe(false)
    const output = join(project, 'editing')
    const directories = await readdir(output)
    expect(directories).toHaveLength(1)
    expect(directories[0]).toMatch(/^dialogue-patch-21-/u)
    const candidate = join(output, directories[0]!, 'clip.mov')
    expect(repaired.value).toMatchObject({ episode: '21', durationMs: 240,
      output: { path: candidate, sha256: await fileSha256(candidate) },
      pronunciation_evidence: { target: args.target_evidence_id, donor: args.donor_evidence_id },
      listeningVerified: false, sourceApproved: false, reviewStatus: 'pending_review' })
    expect(repaired.meta).toMatchObject({ [TOOL_BODY_META_KEY]: repaired.value })
    expect(await fileSha256(target)).toBe(source.target.sha256)
    expect(await fileSha256(donor)).toBe(source.donor.sha256)
  } finally {
    media.mockRestore()
    await ctx.fiber.dispose()
    await runner.dispose()
    await cleanup(root)
  }
}, 45_000)

it('keeps legacy bound-project working renders available but refuses unreviewed staging through the Loader', async () => {
  const root = await tempProject(), ctx = new Context()
  const output = join(root, 'exports', '01.mp4'), draft = join(root, '02_剪映草稿', 'legacy-draft')
  const channel = stubChannel([
    renderedPictureProbe(),
    call => call.command === 'ffprobe' && call.args.at(-1)?.includes('.drama-render-')
      ? { stdout: probeJson({ durationSeconds: 3, video: { width: 480, height: 854, fps: 24 }, audio: {} }) } : undefined,
    probeHandler({
      [join(root, 'source.mp4')]: { durationSeconds: 3, video: { width: 480, height: 854, fps: 24 }, audio: {} },
      [join(root, 'video', '01', 'shot_001.mp4')]: { durationSeconds: 3, video: { width: 480, height: 854, fps: 24 }, audio: {} },
      [output]: { durationSeconds: 3, video: { width: 480, height: 854, fps: 24 }, audio: {} },
    }), decodeHandler(), placeholderHandler(), () => ({}),
  ])
  const factory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue(
    Media.createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }))
  try {
    await writePreviewInputs(root)
    await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 5933,
      project_bible: { schema_version: 1, visual_medium: 'animation_3d', delivery: { width: 480, height: 854, fps: 24 } } }))
    await loadRenderer(ctx, root)
    const tool = ctx.tools.get('drama_render')
    if (tool === undefined) throw new Error('missing Loader renderer')
    expect(await invoke(tool, { method: 'prepare', project: root, episode: 1,
      shots: 'shots.json', subtitle_srt: 'source.srt', bgm: 'approved-bgm.wav' })).toMatchObject({ ok: true })
    expect(await invoke(tool, { method: 'render', project: root, episode: 1,
      timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt', last_shot: 1,
      bgm: 'approved-bgm.wav', output, resume: true })).toMatchObject({ ok: true })
    await mkdir(draft, { recursive: true })
    await expect(invoke(tool, { method: 'stage_delivery', project: root, episode: 1,
      timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt', output, draft }))
      .rejects.toThrow(/实测起止时间/u)
    await expect(readFile(join(root, '01_可交付视频', '第01集.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(output, 'utf8')).toBe('media')
  } finally {
    factory.mockRestore()
    await ctx.fiber.dispose()
    await cleanup(root)
  }
})

it('loads the renderer, accepts public arguments, and removes its tool on disposal', async () => {
  const root = await tempProject()
  const ctx = new Context()
  try {
    await loadRenderer(ctx, root)
    const tool = ctx.tools.get('drama_render')
    expect(tool).toBeDefined()
    if (tool === undefined) throw new Error('missing drama_render')
    const videoTool = ctx.tools.get('drama_video')
    expect(videoTool).toBeDefined()
    if (videoTool === undefined) throw new Error('missing drama_video')
    const video = join(root, 'source.mp4')
    await writeFile(video, 'exact video version')
    const banArgs = { method: 'ban', project: root, video, labels: ['人物对调'], reason: '用户指定' }
    expect(validateJsonSchemaValue(videoTool.parameters, banArgs, '')).toEqual([])
    const ban = await videoTool.execute(banArgs, runContext())
    expect(validateJsonSchemaValue(videoTool.output.schema, ban, '')).toEqual([])
    // The schema check above already validated this value; narrow it for `render`
    // without adding a type-only workspace dependency to this package.
    const rendered = videoTool.output.render(
      banArgs,
      ban as Parameters<typeof videoTool.output.render>[1],
    ) as { type: string; text: string }[]
    const text = rendered[0]?.text ?? ''
    const owned = JSON.parse(text) as Record<string, unknown>
    expect({ ...owned, project: '<project>', manifest_path: '<project>/video-bans.json' }).toMatchInlineSnapshot(`
      {
        "banned": true,
        "labels": [
          "人物对调",
        ],
        "manifest_path": "<project>/video-bans.json",
        "method": "ban",
        "project": "<project>",
        "reason": "用户指定",
        "review_status": "not_assessed",
        "sha256": "cca729571d4b27fc3a64090bf227a3bcbb24b117be88e7ca7e8efaefc2d2a719",
        "videos": [],
      }
    `)
    const listArgs = { method: 'list', project: root }
    expect(validateJsonSchemaValue(videoTool.parameters, listArgs, '')).toEqual([])
    const list = await videoTool.execute(listArgs, runContext())
    expect(validateJsonSchemaValue(videoTool.output.schema, list, '')).toEqual([])
    expect(list).toMatchObject({ banned: true, videos: [{ labels: ['人物对调'], reason: '用户指定', banned: true }] })
    const unban = await videoTool.execute({ method: 'unban', project: root, video }, runContext())
    expect(validateJsonSchemaValue(videoTool.output.schema, unban, '')).toEqual([])
    expect(unban).toMatchObject({ banned: false, review_status: 'not_assessed', labels: ['人物对调'] })
    const missing = join(root, 'missing.json')
    for (const method of ['prepare', 'render', 'verify']) {
      const args = {
        method, project: root, episode: 1, shots: missing, timeline: missing,
        subtitle_srt: join(root, 'subtitles.srt'), last_shot: 1,
        bgm: join(root, 'bgm.wav'), ending_audio: join(root, 'ending.wav'),
        ending_effect: join(root, 'effect.mp4'), output: join(root, 'output.mp4'),
      }
      expect(validateJsonSchemaValue(tool.parameters, args, '')).toEqual([])
      await expect(tool.execute(args, runContext())).rejects.toMatchObject({ code: 'ENOENT', path: missing })
    }
    const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-tool-episode-render')
    expect(entry?.fiber).toBeDefined()
    await entry?.fiber?.dispose()
    expect(ctx.tools.get('drama_render')).toBeUndefined()
    expect(ctx.tools.get('drama_video')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    await cleanup(root)
  }
})

it('reads and writes mixed project-relative and absolute paths through all four Loader methods', async () => {
  const root = await tempProject()
  const ctx = new Context()
  const project = join(root, '中文 项目')
  const cwd = process.cwd()
  const shots = join('输入 文件', '镜头.json')
  const lines = join(project, '输入 文件', '台词.json')
  const alignment = join('输入 文件', '对齐.json')
  const subtitle = join('输入 文件', '对白.srt')
  const video = join(project, '媒体 文件', '原视频.mp4')
  const bgm = join('audio', '配乐 文件.wav')
  const plan = join('editing', '配乐计划.json')
  const endingAudio = join('片尾 素材', '音效.mp3')
  const endingEffect = join(root, '共享 素材', '特效.mp4')
  const output = join('exports', '成片 空格.mp4')
  const outputPath = join(project, output)
  const stub = stubChannel([
    renderedPictureProbe(),
    probeHandler({
      [video]: { durationSeconds: 5, video: {}, audio: {} },
      [join(project, 'video', '01', 'shot_001.mp4')]: { durationSeconds: 5, video: {}, audio: {} },
      [endingEffect]: { durationSeconds: 1.02 },
      [outputPath]: { durationSeconds: 7, sizeBytes: 5_000_000, bitRateBps: 8_000_000, video: {}, audio: {} },
    }),
    seekHandler('tail image'),
    call => call.args.includes('framemd5') ? { stdout: `${framemd5Line(0, 'tail')}\n` } : undefined,
    decodeHandler(),
    placeholderHandler(),
  ])
  const toolkit = Media.createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: stub.channel })
  const mediaFactory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue(toolkit)
  try {
    expect(project).not.toBe(cwd)
    await writePlaceholder(video, 'selected provider video')
    await writePlaceholder(join(project, shots), JSON.stringify({ shots: [{ shot: 1,
      video: join('媒体 文件', '原视频.mp4') }] }))
    await writePlaceholder(lines, JSON.stringify({ shots: [{ shot: 1, lines: ['原文台词'] }] }))
    await writePlaceholder(join(project, alignment), JSON.stringify({ shots: [{ shot: 1, strategy: 'asr_aligned',
      cues: [{ text: '原文台词', start: 1, end: 2 }] }] }))
    await writePlaceholder(join(project, bgm), 'approved BGM')
    await writePlaceholder(join(project, plan), JSON.stringify({ episodes: [{ episode: '01', body_duration_seconds: 5,
      segments: [{ track: '已选曲目', source: bgm, start_seconds: 0, end_seconds: 5, reason: '剧情' }] }] }))
    await mkdir(join(project, '片尾 素材'), { recursive: true })
    await mkdir(join(root, '共享 素材'), { recursive: true })
    await copyFile(shippedEndingAsset('ending_audio.mp3'), join(project, endingAudio))
    await copyFile(shippedEndingAsset('ending_effect.mp4'), endingEffect)
    await loadRenderer(ctx, root)
    const tool = ctx.tools.get('drama_render')
    if (tool === undefined) throw new Error('missing drama_render')
    await invoke(tool, { method: 'subtitles', project, episode: 1, shots, lines, alignment, subtitle_srt: subtitle })
    const subtitleText = await readFile(join(project, subtitle), 'utf8')
    expect(subtitleText).toContain('00:00:01,000 --> 00:00:02,000\n原文台词')
    const sourceBlock = `${join(project, subtitle)}.blocked`
    await writeFile(sourceBlock, 'subtitle alignment pending\n', 'utf8')
    const preparedWithWarning = await invoke(tool, { method: 'prepare', project, episode: 1, shots,
      subtitle_srt: join(project, subtitle) })
    expect(JSON.stringify(preparedWithWarning)).toContain('字幕对齐待核')
    await rm(sourceBlock)
    const preparedPlan = await invoke(tool, { method: 'prepare', project, episode: 1, shots,
      subtitle_srt: join(project, subtitle), bgm, bgm_plan: plan })
    expect(preparedPlan).toMatchObject({ ok: true, bgm_plan: { path: join(project, plan), segments: [{ track: '已选曲目' }] },
      render_preview: { audio: { bgm_path: join(project, bgm), bgm_plan_path: join(project, plan) } } })
    expect(await readFile(join(project, 'video', '01', 'shot_001.mp4'), 'utf8')).toBe('selected provider video')
    expect(await readFile(join(project, 'editing', '01.srt'), 'utf8')).toBe(subtitleText)
    const timeline = join('editing', '01-timeline.json')
    expect(JSON.parse(await readFile(join(project, timeline), 'utf8'))).toMatchObject({ body_end: 5 })
    const deliveryBlock = `${join(project, 'editing', '01.srt')}.blocked`
    await writeFile(deliveryBlock, 'subtitle alignment pending\n', 'utf8')
    const rendered = await invoke(tool, { method: 'render', project, episode: 1, timeline,
      subtitle_srt: join('editing', '01.srt'), last_shot: 1, bgm, bgm_plan: plan,
      ending_audio: endingAudio, ending_effect: endingEffect, output })
    expect(JSON.stringify(rendered)).toContain('字幕对齐待核')
    await rm(deliveryBlock)
    expect(rendered).toMatchObject({ ok: true, output: outputPath, bgm_plan: { path: join(project, plan) } })
    expect(await readFile(outputPath, 'utf8')).toBe('media')
    expect(JSON.parse(await readFile(`${outputPath}.source-record.json`, 'utf8')))
      .toMatchObject({ output: { path: outputPath } })
    const verified = await invoke(tool, { method: 'verify', project, episode: 1, output,
      timeline: join(project, timeline), subtitle_srt: join('editing', '01.srt') })
    expect(verified).toMatchObject({ ok: true, output: outputPath, written: [] })
    const probed = stub.calls.filter(call => call.command === 'ffprobe').map(call => call.args.at(-1))
    expect(probed).toEqual(expect.arrayContaining([video, endingEffect, outputPath]))
    expect(probed).toContain(join(project, 'exports', '.render_cache', '01', 'subtitled.mp4'))
    expect(process.cwd()).toBe(cwd)
  } finally {
    mediaFactory.mockRestore()
    await ctx.fiber.dispose()
    await cleanup(root)
  }
})

it('exposes the selected 480p render inputs through Loader prepare, render and the written log', async () => {
  const root = await tempProject()
  const ctx = new Context()
  const video = join(root, 'source.mp4')
  const output = join(root, 'exports', 'candidate.mp4')
  const bgm = join(root, 'approved-bgm.wav')
  const stub = stubChannel([
    renderedPictureProbe(),
    probeHandler({ [video]: { durationSeconds: 5, video: { width: 480, height: 854, fps: 24 }, audio: {} },
      [join(root, 'video', '23', 'shot_001.mp4')]: { durationSeconds: 5, video: { fps: 24 } },
      [output]: { durationSeconds: 5, video: { width: 480, height: 854, fps: 24 }, audio: {} } }),
    placeholderHandler(),
  ])
  const mediaFactory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue(
    Media.createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: stub.channel }))
  try {
    await writePreviewInputs(root)
    await loadRenderer(ctx, root)
    const tool = ctx.tools.get('drama_render')
    if (tool === undefined) throw new Error('missing drama_render')
    const prepared = await invoke(tool, { method: 'prepare', project: root, episode: 23, shots: 'shots.json',
      subtitle_srt: 'source.srt', bgm: 'approved-bgm.wav' })
    expect(prepared).toMatchObject({ ok: true, render_preview: {
      delivery: { width: 480, height: 854, fps: 24 },
      subtitle: { path: join(root, 'editing', '23.srt'), font_size_design: 40, font_size_output_px: 17.773 },
      audio: { bgm_path: bgm, bgm_plan_path: '', master_gain: 1.45, bgm_gain: 0.24 } } })
    const rendered = await invoke(tool, { method: 'render', project: root, episode: 23, timeline: 'editing/23-timeline.json',
      subtitle_srt: 'editing/23.srt', last_shot: 1, bgm: 'approved-bgm.wav', output })
    expect(rendered).toMatchObject({ ok: true, bgm_plan: { path: '', segments: [] }, render_preview: {
      delivery: { width: 480, height: 854, fps: 24 }, audio: { bgm_path: bgm, bgm_plan_path: '' } } })
    const log = await readFile(join(root, 'exports', '.render_cache', '23', 'render.log'), 'utf8')
    expect(log).toContain('render_preview=')
    expect(log).toContain('"font_size_output_px":17.773')
    expect(log).toContain(JSON.stringify(bgm))
    const mux = stub.calls.find(call => call.args.includes('-stream_loop'))
    expect(mux?.args).toContain(bgm)
    expect(mux?.args.join(' ')).toContain('[2:a]aresample=48000,asetpts=N/SR/TB,atrim=0:5.000000,volume=0.24[a1]')
    expect(await readFile(output, 'utf8')).toBe('media')
  } finally {
    mediaFactory.mockRestore()
    await ctx.fiber.dispose()
    await cleanup(root)
  }
})

it('carries project subtitle and gain snapshots through Loader prepare, ASS, mux and log', async () => {
  const root = await tempProject()
  const ctx = new Context()
  const video = join(root, 'source.mp4')
  const output = join(root, 'exports', 'configured.mp4')
  const stub = stubChannel([
    renderedPictureProbe(),
    probeHandler({ [video]: { durationSeconds: 5, video: { width: 480, height: 854, fps: 24 }, audio: {} },
      [join(root, 'video', '23', 'shot_001.mp4')]: { durationSeconds: 5, video: { fps: 24 } },
      [output]: { durationSeconds: 5, video: { width: 480, height: 854, fps: 24 }, audio: {} } }),
    placeholderHandler(),
  ])
  const mediaFactory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue(
    Media.createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: stub.channel }))
  const subtitle = { font_family: 'Project font', font_size_px: 30, margin_bottom_px: 18 }
  const audio = { master_gain: 1, bgm_gain: 0 }
  const draft_style = { watermark: { font_size_ui: 7 }, subtitle: { font_family: '山海经', font_size_ui: 11,
    border_width_ui: 20, transform_y: -0.465625 } }
  try {
    await writePreviewInputs(root)
    const config = { project_bible: { visual_medium: 'animation_3d',
      delivery: { width: 480, height: 854, fps: 24, subtitle, audio, draft_style } } }
    await writeFile(join(root, 'project_config.json'), JSON.stringify(config))
    await loadRenderer(ctx, root)
    const tool = ctx.tools.get('drama_render')
    if (tool === undefined) throw new Error('missing drama_render')
    const prepared = await invoke(tool, { method: 'prepare', project: root, episode: 23, shots: 'shots.json',
      subtitle_srt: 'source.srt', bgm: 'approved-bgm.wav' })
    expect(prepared).toMatchObject({ render_preview: { subtitle: { font_family: 'Project font', font_size_output_px: 30 },
      audio: { master_gain: 1, bgm_gain: 0 } } })
    expect(JSON.parse(await readFile(join(root, 'editing', '23-timeline.json'), 'utf8')))
      .toMatchObject({ delivery: { subtitle, audio, draft_style } })
    // Later project changes cannot silently restyle or remix the prepared episode.
    config.project_bible.delivery.subtitle = { font_family: 'Later font', font_size_px: 50, margin_bottom_px: 50 }
    config.project_bible.delivery.audio = { master_gain: 2, bgm_gain: 1 }
    await writeFile(join(root, 'project_config.json'), JSON.stringify(config))
    const rendered = await invoke(tool, { method: 'render', project: root, episode: 23, timeline: 'editing/23-timeline.json',
      subtitle_srt: 'editing/23.srt', last_shot: 1, bgm: 'approved-bgm.wav', output })
    expect(rendered).toMatchObject({ render_preview: { subtitle: { font_family: 'Project font', font_size_output_px: 30 },
      audio: { master_gain: 1, bgm_gain: 0 } } })
    const cache = join(root, 'exports', '.render_cache', '23')
    const ass = await readFile(join(cache, 'display.ass'), 'utf8')
    expect(ass).toContain('Style: Default,Project font,67.518,')
    expect(ass).toContain('0,2,40,40,41,1')
    const mux = stub.calls.find(call => call.args.includes('-stream_loop'))
    expect(mux?.args.join(' ')).toContain('[1:a]aresample=48000,asetpts=N/SR/TB,apad,atrim=end_sample=240000,volume=1[a0]')
    expect(mux?.args.join(' ')).toContain('[2:a]aresample=48000,asetpts=N/SR/TB,atrim=0:5.000000,volume=0[a1]')
    const log = await readFile(join(cache, 'render.log'), 'utf8')
    expect(log).toContain('"font_family":"Project font"')
    expect(log).toContain('"master_gain":1,"bgm_gain":0')
  } finally {
    mediaFactory.mockRestore()
    await ctx.fiber.dispose()
    await cleanup(root)
  }
})

it.each([null, { font_size_px: 0.0001 }])('rejects explicit invalid project style %j before Loader prepare starts media or writes products', async (subtitle) => {
  const root = await tempProject()
  const ctx = new Context()
  const stub = stubChannel([])
  const mediaFactory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue(
    Media.createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: stub.channel }))
  try {
    await writePreviewInputs(root)
    await writeFile(join(root, 'project_config.json'), JSON.stringify({ project_bible: {
      delivery: { width: 480, height: 854, fps: 24, subtitle } } }))
    await loadRenderer(ctx, root)
    const tool = ctx.tools.get('drama_render')
    if (tool === undefined) throw new Error('missing drama_render')
    await expect(invoke(tool, { method: 'prepare', project: root, episode: 1, shots: 'shots.json',
      subtitle_srt: 'source.srt' })).rejects.toThrow('.subtitle')
    expect(stub.calls).toEqual([])
    await expect(readFile(join(root, 'editing', '01-timeline.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    mediaFactory.mockRestore()
    await ctx.fiber.dispose()
    await cleanup(root)
  }
})

it.each([
  { label: 'missing', contents: undefined, error: 'BGM 计划不可读' },
  { label: 'malformed', contents: '{', error: 'BGM 计划不可读' },
  { label: 'stale duration', contents: JSON.stringify({ episodes: [{ episode: '23', body_duration_seconds: 6,
    segments: [{ track: 'chosen', source: 'approved-bgm.wav', start_seconds: 0, end_seconds: 5 }] }] }),
  error: 'BGM 计划正文时长与当前时间线不一致' },
])('keeps Loader prepare files when the optional plan is $label while render still rejects it', async ({ contents, error }) => {
  const root = await tempProject()
  const ctx = new Context()
  const video = join(root, 'source.mp4')
  const plan = join(root, 'optional-plan.json')
  const stub = stubChannel([probeHandler({ [video]: { durationSeconds: 5, video: { width: 480, height: 854, fps: 24 } } }),
    placeholderHandler()])
  const mediaFactory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue(
    Media.createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: stub.channel }))
  try {
    await writePreviewInputs(root)
    if (contents !== undefined) await writeFile(plan, contents)
    await loadRenderer(ctx, root)
    const tool = ctx.tools.get('drama_render')
    if (tool === undefined) throw new Error('missing drama_render')
    const prepared = await invoke(tool, { method: 'prepare', project: root, episode: 23, shots: 'shots.json',
      subtitle_srt: 'source.srt', bgm: 'approved-bgm.wav', bgm_plan: 'optional-plan.json' })
    expect(prepared).toMatchObject({ ok: true, bgm_plan: { path: '', segments: [] },
      render_preview: { audio: { bgm_path: join(root, 'approved-bgm.wav'), bgm_plan_path: plan } } })
    expect(prepared).toHaveProperty('not_checked', expect.arrayContaining(['bgm_plan', 'bgm_license_info']))
    expect(prepared).toHaveProperty('warnings', expect.arrayContaining([
      expect.stringContaining('prepare 已完成'), expect.stringContaining(error),
    ]))
    const files = ['video/23/shot_001.mp4', 'audio/23.wav', 'editing/23.srt',
      'editing/23-timeline.json', 'editing/23-sources.json'].map(path => join(root, path))
    const before = await Promise.all(files.map(path => readFile(path)))
    expect(before[0]?.toString()).toBe('selected source')
    expect(before[1]?.toString()).toBe('media')
    expect(before[2]?.toString()).toBe(await readFile(join(root, 'source.srt'), 'utf8'))
    expect(JSON.parse(before[3]?.toString() ?? '')).toMatchObject({ body_end: 5, delivery: { width: 480, height: 854, fps: 24 } })
    expect(JSON.parse(before[4]?.toString() ?? '')).toMatchObject({ shots: [{ shot: 1, video }] })
    const commands = stub.calls.length
    await expect(invoke(tool, { method: 'render', project: root, episode: 23, timeline: 'editing/23-timeline.json',
      subtitle_srt: 'editing/23.srt', last_shot: 1, bgm: 'approved-bgm.wav', bgm_plan: 'optional-plan.json' })).rejects.toThrow(error)
    expect(stub.calls).toHaveLength(commands)
    expect(await Promise.all(files.map(path => readFile(path)))).toEqual(before)
  } finally {
    mediaFactory.mockRestore()
    await ctx.fiber.dispose()
    await cleanup(root)
  }
})

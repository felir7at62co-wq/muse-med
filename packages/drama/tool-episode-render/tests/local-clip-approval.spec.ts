import { appendFile, copyFile, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { type Session, SessionId } from '@deepseek-ai/dsh-session'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import { afterEach, expect, it, vi } from 'vitest'
import { verifySelectedSourceReviews } from '../src/approved-sources.ts'
import { fileSha256 } from '../src/cache.ts'
import { createMediaToolkit, firstStreamOfType, probeMedia } from '../src/ffmpeg.ts'
import { resolveSettings } from '../src/index.ts'
import { createLocalClipRepairVerifier, localClipRepairBindingSchema, type LocalClipRepairBinding } from '../src/local-clip-evidence.ts'
import { registerLocalClipTool, type VisualRepairEvidenceVerifier } from '../src/local-clip-tool.ts'
import { episodePaths, pathExists } from '../src/paths.ts'
import { prepareEpisode, preparedSubtitleClockInputs } from '../src/prepare.ts'
import { renderEpisode } from '../src/render.ts'
import { endingRestoreBindingSchema } from '../src/restore-ending.ts'
import { createSourceQaStagedAccess, verifySourceQa, type SourceQaStagedAccess } from '../src/source-qa.ts'
import { subtitleClockPath, writeSubtitleClock } from '../src/subtitle-clock.ts'
import { createMediaRunner, ffmpeg, ffprobe, hasFfmpeg } from './audio-ffmpeg-harness.ts'
import { cleanup, probeHandler, srtDocument, stubChannel, tempProject, writePlaceholder } from './harness.ts'
import { sourceQaFixture, verifiedSourceQaFixture } from './source-qa-fixture.ts'

const projects: string[] = []
afterEach(async () => { await Promise.all(projects.splice(0).map(cleanup)) })

async function fixture() {
  const project = await realpath(await tempProject())
  projects.push(project)
  const episode = '24'
  const paths = episodePaths(project, episode)
  const original = join(project, 'provider-original.mp4')
  const video = join(project, 'local-repair.mp4')
  const reviewPath = join(project, 'reviews', 'ep24-p01.json')
  const packagePath = join(project, 'episode_packages', episode, 'package.json')
  const frame = join(project, 'review-frame.png')
  const receipt = join(project, 'provider-original.download.json')
  await Promise.all([
    writePlaceholder(original, 'provider download with picture and original sound'),
    writePlaceholder(video, 'locally trimmed picture and sound'),
    writePlaceholder(frame, 'selected clip frame'),
    writePlaceholder(packagePath, JSON.stringify({ episode, video_tasks: [{ shots: [1] }] })),
  ])
  const [originalSha256, videoSha256, packageSha256, source, selected] = await Promise.all([
    fileSha256(original), fileSha256(video), fileSha256(packagePath),
    sourceQaFixture(project, original, 'original'), sourceQaFixture(project, video),
  ])
  const duration = 3
  selected.ocr.duration_seconds = duration
  selected.ocr.interval.end_seconds = duration
  selected.ocr.coverage.scanned_ranges[0]!.end_seconds = duration
  selected.ocr.frames = selected.ocr.frames.slice(0, 6)
  selected.ocr.coverage.planned_frame_count = selected.ocr.frames.length
  selected.ocr.coverage.processed_frame_count = selected.ocr.frames.length
  selected.inspection.duration = duration
  selected.inspection.scanned_until = duration
  await selected.save()
  const download = { version: 1, kind: 'video', media_type: 'video/mp4', path: original,
    sha256: 'sha256:' + originalSha256, source_sha256: 'a'.repeat(64) }
  await writePlaceholder(receipt, JSON.stringify(download))
  const row = { shot: 1, package: 1, video, audio: video }
  const binding: LocalClipRepairBinding = { project, episode,
    original: { path: original, sha256: originalSha256 }, output: { path: video, sha256: videoSha256 },
    startMs: 1000, endMs: 4000, durationSeconds: duration }
  const review = {
    episode, package: 1, status: 'approved', subtitle_cleanup: 'not_required',
    package_sha256: packageSha256, video_path: video, video_sha256: videoSha256,
    audio_path: video, audio_sha256: videoSha256, review_frames: [frame],
    original_download_receipt_path: receipt,
    local_clip_repair: { original_path: original, original_sha256: originalSha256,
      start_ms: binding.startMs, end_ms: binding.endMs, duration_seconds: binding.durationSeconds },
    source_qa: { version: 1, selected: selected.declaration, original: source.declaration },
    content_review: { identity: 'pass', wardrobe: 'pass', scene: 'pass', prop: 'pass', action_and_dialogue: 'pass',
      visible_artifacts: 'pass', continuity: 'pass', voice_and_speaker: 'pass', av_sync: 'pass',
      sensitive_content: 'pass', embedded_subtitles: 'absent' },
  }
  const save = (data: unknown = review) => writePlaceholder(reviewPath, JSON.stringify(data))
  await save()
  return { paths, row, binding, review, save, receipt, download }
}

function recordRepair(session: Session, binding: LocalClipRepairBinding): void {
  const callId = ToolCallId('local-clip-approval')
  const { pictureClock, ...details } = binding
  const evidence = { ...details, ...(pictureClock === undefined ? {} : { pictureClock }) }
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'drama_repair_clip', arguments: '{}' })
  session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: JSON.stringify(binding) }] }),
    meta: { [TOOL_BODY_META_KEY]: evidence } }, { surfaceOp: 'append' })
}

it('binds strict approval to the exact native receipt and captures both reviewed files', async () => {
  const f = await fixture()
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  try {
    const verifyRepair = await createLocalClipRepairVerifier(ctx)
    const session = ctx.sessions.create(SessionId(f.review.source_qa.selected.inspection.session_id))
    const unrelated = ctx.sessions.create(SessionId('unrelated-clip-review'))
    const signal = new AbortController().signal
    const check = (owner: Session, staged?: SourceQaStagedAccess) =>
      verifySelectedSourceReviews(f.paths, [f.row], true, true, async ({ localRepair }) => {
        if (localRepair !== undefined) verifyRepair(owner, localRepair, signal)
      }, staged)
    recordRepair(unrelated, f.binding)
    await expect(check(session)).rejects.toThrow('SOURCE_LOCAL_CLIP')
    recordRepair(session, f.binding)
    const [reviewed] = await check(session)
    expect(reviewed).toMatchObject({ videoSha256: f.binding.output.sha256, audioSha256: f.binding.output.sha256,
      localRepair: f.binding, requiresLocalRepairClock: true })
    for (const path of [f.binding.original.path, f.binding.output.path, f.receipt,
      f.review.source_qa.original.ocr.path, f.review.source_qa.original.inspection.path,
      f.review.source_qa.selected.ocr.path, f.review.source_qa.selected.inspection.path]) {
      expect(reviewed?.sourceQa?.files).toContainEqual({ path, sha256: await fileSha256(path) })
    }
    const stage = join(f.paths.project, 'private-stage')
    await mkdir(stage)
    const inputs = [...new Map(reviewed?.sourceQa?.files.map(file => [file.path, file])).values()]
    const copies = await Promise.all(inputs.map(async (file, index) => {
      const stagedPath = join(stage, String(index))
      await copyFile(file.path, stagedPath)
      return { originalPath: file.path, stagedPath, sha256: file.sha256, bytes: (await stat(stagedPath)).size }
    }))
    const directories = [{ originalPath: join(f.paths.project, 'reviews'), entries: ['ep24-p01.json'] }]
    const staged = createSourceQaStagedAccess(f.paths.project, stage, copies, signal, directories)
    expect(await check(session, staged)).toEqual([reviewed])
    const incomplete = createSourceQaStagedAccess(f.paths.project, stage,
      copies.filter(file => file.originalPath !== f.binding.original.path), signal, directories)
    await expect(check(session, incomplete)).rejects.toThrow('no captured mapping')
    await f.save({ ...f.review, local_clip_repair: { ...f.review.local_clip_repair, start_ms: 500, end_ms: 3500 } })
    await expect(check(session)).rejects.toThrow('SOURCE_LOCAL_CLIP')
  } finally { await ctx.fiber.dispose() }
})

it('refuses a different download receipt, stale original bytes or untrimmed audio', async () => {
  const f = await fixture()
  const { original, output } = f.binding
  const check = () => verifySelectedSourceReviews(f.paths, [f.row], true, true, verifiedSourceQaFixture)
  await writePlaceholder(f.receipt, JSON.stringify({ ...f.download, sha256: 'sha256:' + output.sha256 }))
  await expect(check()).rejects.toThrow('正式下载回执与本次选片')
  await writePlaceholder(f.receipt, JSON.stringify(f.download))
  await f.save({ ...f.review, audio_path: original.path, audio_sha256: original.sha256 })
  await expect(verifySelectedSourceReviews(f.paths, [{ ...f.row, audio: original.path }], true, true, verifiedSourceQaFixture))
    .rejects.toThrow('须使用工具输出的同片原声')
  await f.save()
  await writePlaceholder(original.path, 'different media at the same path')
  await expect(check()).rejects.toThrow('局部返工的原片已经变化')
})

it('requires original and candidate observations with clocks consistent with the receipt', async () => {
  const f = await fixture()
  const check = () => verifySelectedSourceReviews(f.paths, [f.row], true, true, verifiedSourceQaFixture)
  await f.save({ ...f.review, source_qa: { version: 1, selected: f.review.source_qa.selected } })
  await expect(check()).rejects.toThrow('复验没有绑定本次实际源片')
  await f.save({ ...f.review, source_qa: { ...f.review.source_qa, selected: f.review.source_qa.original } })
  await expect(check()).rejects.toThrow('复验没有绑定本次实际源片')
  await f.save({ ...f.review, local_clip_repair: { ...f.review.local_clip_repair, end_ms: 6000 } })
  await expect(check()).rejects.toThrow('候选实测时长与工具回执不符')
  await f.save({ ...f.review, local_clip_repair: { ...f.review.local_clip_repair, duration_seconds: 4 } })
  await expect(check()).rejects.toThrow('候选实测时长与工具回执不符')
})

it('refuses malformed or mixed repair declarations before trusting any Host observation', async () => {
  const f = await fixture()
  const verifier = vi.fn(verifiedSourceQaFixture)
  const check = () => verifySelectedSourceReviews(f.paths, [f.row], true, true, verifier)
  for (const conflict of [
    { local_clip_repair: null }, { subtitle_cleanup: 'clean' }, { subtitle_erasure: {} }, { video_upscale: {} },
  ]) {
    await f.save({ ...f.review, ...conflict })
    await expect(check()).rejects.toThrow('须使用工具输出的同片原声')
  }
  await f.save({ ...f.review, local_clip_repair: { ...f.review.local_clip_repair, end_ms: f.binding.startMs } })
  await expect(check()).rejects.toThrow('审核缺少本次工具的原片、区间或时长记录')
  expect(verifier).not.toHaveBeenCalled()
})

it('requires the exact clip project and same original audio and video binding even with a Host verifier', async () => {
  const f = await fixture()
  const { project, original, output } = f.binding
  const verifier = vi.fn(verifiedSourceQaFixture)
  const input = { project, review: f.review, localRepair: f.binding, verifier,
    videoPath: output.path, videoSha256: output.sha256, originalPath: output.path, originalSha256: output.sha256 }
  for (const changed of [
    { localRepair: { ...f.binding, project: join(project, 'different-project') } },
    { localRepair: { ...f.binding, output: original } },
    { originalPath: original.path }, { originalSha256: original.sha256 }, { videoSha256: original.sha256 },
  ]) {
    await expect(verifySourceQa({ ...input, ...changed })).rejects.toThrow('核验工具输出的同片画面和原声')
  }
  expect(verifier).not.toHaveBeenCalled()
  const accepted = await verifySourceQa(input)
  expect(accepted.files).toContainEqual(output)
  expect(accepted.files).toContainEqual(original)
  expect(verifier.mock.calls.map(([evidence]) => evidence.localRepair)).toEqual([f.binding, undefined])
})

it('denies local repair and ending replacement before media work when the current visual proof fails', async () => {
  const { binding } = await fixture()
  const { project, original, output } = binding
  const ctx = new Context()
  const media = stubChannel([])
  const verify = vi.fn<VisualRepairEvidenceVerifier>().mockImplementation(async (_session, path) => {
    if (path === output.path) throw new Error('Donor observation does not belong to this source')
  })
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: project })
    const driver = await mountAgentLoopTestHarness(ctx)
    const agent = await driver.create(SessionId('local-clip-visual-proof'), {}, { cwd: project })
    registerLocalClipTool(ctx, { ...resolveSettings(), channel: media.channel }, verify)
    const region = { x: 10, y: 20, width: 80, height: 60 }
    const evidence = {
      review_id: 'original-review', defect_seconds: 2,
      before: { frame_id: 'before-1', region }, after: { frame_id: 'after-1', region },
    }
    const donorEvidence = { ...evidence, review_id: 'donor-review' }
    const invoke = (name: string, args: Record<string, unknown>) => executeModelToolFixture(ctx, { name,
      arguments: args, callId: ToolCallId(name), signal: new AbortController().signal, agent })

    const cropArgs = { project, episode: 24, input: output.path, start_ms: 1000, end_ms: 3000 }
    expect(await invoke('drama_repair_clip', cropArgs)).toMatchObject({ isError: true })
    expect(verify).not.toHaveBeenCalled()
    const crop = await invoke('drama_repair_clip', { ...cropArgs, visual_evidence: donorEvidence })
    expect(crop.isError).toBe(true)
    expect(JSON.stringify(crop.content)).toContain('Donor observation does not belong to this source')

    const endingArgs = { project, episode: 24, original: original.path, donor: output.path, start_ms: 1500,
      visual_evidence: evidence, donor_evidence: donorEvidence }
    verify.mockClear()
    const early = await invoke('drama_restore_ending', { ...endingArgs, visual_evidence: { ...evidence, defect_seconds: 1 } })
    expect(early.isError).toBe(true)
    expect(JSON.stringify(early.content)).toContain('片尾复看时点必须处在拟替换区间内')
    expect(verify).not.toHaveBeenCalled()
    const ending = await invoke('drama_restore_ending', endingArgs)
    expect(ending.isError).toBe(true)
    expect(JSON.stringify(ending.content)).toContain('Donor observation does not belong to this source')
    expect(verify.mock.calls.map(([session, path, observation]) => ({ session, path, observation }))).toEqual([
      { session: agent.session, path: original.path, observation: evidence },
      { session: agent.session, path: output.path, observation: donorEvidence },
    ])
    expect(media.calls).toEqual([])
    expect(await fileSha256(original.path)).toBe(original.sha256)
    expect(await fileSha256(output.path)).toBe(output.sha256)
  } finally {
    await ctx.fiber.dispose()
  }
})

it.skipIf(!hasFfmpeg).each(['Host channel', 'native file capture'] as const)(
  'requires visual approval and preserves both physical ending sources with %s', async (media) => {
    const workspace = await tempProject()
    projects.push(workspace)
    const ctx = new Context()
    const runner = createMediaRunner()
    try {
      const project = join(workspace, 'project'), unrelated = join(workspace, 'not-in-project.mp4')
      await mkdir(project)
      const original = join(project, 'broken-tail.mp4'), donor = join(project, 'verified-tail.mp4')
      const encode = async (path: string, frequency: number, filter?: string) => {
        const encoded = await runner.runCommand(ffmpeg, ['-n', '-v', 'error', '-f', 'lavfi', '-i',
          'testsrc2=size=128x96:rate=24:duration=2', '-f', 'lavfi', '-i',
          `sine=frequency=${String(frequency)}:sample_rate=48000:duration=2`,
          ...(filter === undefined ? [] : ['-vf', filter]), '-map', '0:v', '-map', '1:a',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path])
        expect(encoded.code, encoded.stderr).toBe(0)
      }
      await encode(original, 337)
      await encode(donor, 883, "drawbox=x=4:y=3:w=iw-8:h=ih-6:color=green:t=fill:enable='gte(n,24)'")
      await copyFile(original, unrelated)
      const originalHash = await fileSha256(original), donorHash = await fileSha256(donor)
      const region = { x: 8, y: 8, width: 80, height: 60 }
      const evidence = (name: string) => ({ review_id: name, defect_seconds: 1.5,
        before: { frame_id: `${name}-before`, region }, after: { frame_id: `${name}-after`, region } })
      const originalEvidence = evidence('original'), donorEvidence = evidence('donor')
      let changedAfterReview: string | undefined
      const verify = vi.fn<VisualRepairEvidenceVerifier>(async (_session, path, proof) => {
        expect(proof).toEqual(path === original ? originalEvidence : donorEvidence)
        expect(await fileSha256(path)).toBe(path === original ? originalHash : donorHash)
        if (changedAfterReview === path) await appendFile(path, 'superseded bytes')
      })
      const channel = { run: vi.fn(runner.channel.run) }
      const settings = { ...resolveSettings({ ffmpegPath: ffmpeg, ffprobePath: ffprobe }),
        ...(media === 'Host channel' ? { channel } : {}) }
      await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
      await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: workspace })
      const driver = await mountAgentLoopTestHarness(ctx)
      const agent = await driver.create(SessionId('visual-approval-owner'), {}, { cwd: workspace })
      registerLocalClipTool(ctx, settings, verify)
      const args = { project: 'project', episode: 43, original: 'broken-tail.mp4', donor: 'verified-tail.mp4', start_ms: 1000,
        visual_evidence: originalEvidence, donor_evidence: donorEvidence }
      const cut = { project: 'project', episode: 43, input: 'broken-tail.mp4', start_ms: 500, end_ms: 1500,
        visual_evidence: originalEvidence }
      const signal = new AbortController().signal
      const request = (name: string, input: Record<string, unknown>) => ({ name,
        callId: ToolCallId(name), arguments: input, signal })
      const invoke = (name: string, input: Record<string, unknown>) => executeModelToolFixture(ctx, { ...request(name, input), agent })
      const rejected = async (name: string, input: Record<string, unknown>, detail: string) => {
        const result = await invoke(name, input)
        expect(result.isError).toBe(true)
        expect(JSON.stringify(result.content)).toContain(detail)
      }
      for (const [name, parameters] of [['drama_restore_ending', args], ['drama_repair_clip', cut], ['drama_conform_clip',
        { project: 'project', episode: 43, original: 'broken-tail.mp4', processed: 'verified-tail.mp4' }]] as const) {
        const noAgent = await executeModelToolFixture(ctx, request(name, parameters))
        expect(JSON.stringify(noAgent.content)).toContain('普通 Muse 会话')
      }
      agent.session.append('sandbox/mode', { mode: 'read-only' })
      await rejected('drama_restore_ending', args, '仅可读取文件')
      agent.session.append('sandbox/mode', { mode: 'workspace-write' })
      await rejected('drama_restore_ending', { ...args, project: 'not-in-project.mp4' }, '授权工作区')
      await rejected('drama_restore_ending', { ...args, original: unrelated }, '当前项目内的文件')
      expect(verify).not.toHaveBeenCalled()
      changedAfterReview = original
      const originalBytes = await readFile(original)
      await rejected('drama_repair_clip', cut, '源片在复验期间变化')
      await writeFile(original, originalBytes)
      await rejected('drama_restore_ending', args, '审看的片尾来源已变化')
      await writeFile(original, originalBytes)
      expect(channel.run).not.toHaveBeenCalled()
      expect(await pathExists(join(project, 'editing'))).toBe(false)
      changedAfterReview = undefined

      verify.mockClear()
      const clipped = await invoke('drama_repair_clip', cut)
      expect(clipped.isError, JSON.stringify(clipped.content)).toBe(false)
      const clip = localClipRepairBindingSchema.parse(clipped.value)
      expect(clip.original).toEqual({ path: original, sha256: originalHash })
      expect(verify.mock.calls.map(([session, path]) => [session?.id, path])).toEqual([[agent.id, original]])
      verify.mockClear()
      const restored = await invoke('drama_restore_ending', args)
      expect(restored.isError, JSON.stringify(restored.content)).toBe(false)
      const result = endingRestoreBindingSchema.parse(restored.value)
      expect(restored.meta).toMatchObject({ [TOOL_BODY_META_KEY]: result })
      expect(result).toMatchObject({ project, episode: '43', original: { path: original, sha256: originalHash },
        donor: { path: donor, sha256: donorHash }, startMs: 1000, endMs: 2000, clock: { frames: 48, startFrame: 24 } })
      expect(verify.mock.calls.map(([session, path, proof]) => [session?.id, path, proof])).toEqual([
        [agent.id, original, originalEvidence], [agent.id, donor, donorEvidence],
      ])
      for (const { output } of [clip, result]) {
        expect(await fileSha256(output.path)).toBe(output.sha256)
        expect(await readdir(dirname(output.path))).toEqual(['clip.mp4'])
      }
      expect(firstStreamOfType(await probeMedia({ ffmpeg, ffprobe, channel }, result.output.path), 'audio'))
        .toMatchObject({ startSeconds: 0, durationSeconds: 2, sampleRate: 48_000 })
      expect(await fileSha256(original)).toBe(originalHash)
      expect(await fileSha256(donor)).toBe(donorHash)
      expect(await fileSha256(unrelated)).toBe(originalHash)
    } finally {
      await ctx.fiber.dispose()
      await runner.dispose()
    }
  }, 45_000)

it('requires a new generated subtitle clock for a selected local cut, including a strict render after the marker is removed', async () => {
  const { paths, row, binding } = await fixture()
  const { project, episode } = paths
  const shotsPath = join(project, 'shots.json')
  const subtitleSrt = join(project, 'candidate.srt')
  const text = srtDocument([{ start: '00:00:00,100', end: '00:00:00,500', text: '台词' }])
  await Promise.all([
    writePlaceholder(shotsPath, JSON.stringify({ shots: [row] })),
    writePlaceholder(subtitleSrt, text),
    writePlaceholder(join(project, 'project_config.json'), JSON.stringify({
      project_bible: { visual_medium: 'animation_3d', delivery: { require_source_review: true } },
    })),
  ])
  const media = stubChannel([
    probeHandler({ [row.video]: { durationSeconds: 3, video: {}, audio: {} } }),
    call => ({ after: async () => { await writePlaceholder(call.args.at(-1)!, 'prepared sound') } }),
  ])
  const toolkit = createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: media.channel })
  const prepare = () => prepareEpisode({ toolkit, project, episode, shotsPath, subtitleSrt })
  const missingClock = '局部返工缺少与当前音画一致的生成字幕时钟'
  await expect(prepare()).rejects.toThrow(missingClock)
  expect(await pathExists(paths.sources)).toBe(false)
  const source = binding.original.path
  await writeSubtitleClock(subtitleSrt, text, episode,
    [{ source: { ...row, video: source, audio: source }, video: source, audio: source, durationUs: 5_000_000 }])
  await expect(prepare()).rejects.toThrow('生成字幕与当前集、分包素材或切点不一致')
  expect(await pathExists(paths.sources)).toBe(false)

  await writeSubtitleClock(subtitleSrt, text, episode,
    [{ source: row, video: row.video, audio: row.audio, durationUs: 3_000_000 }])
  await prepare()
  const document = JSON.parse(await readFile(paths.sources, 'utf8')) as Record<string, unknown>
  expect(document.local_repair_subtitle_clock_required).toBe(true)
  const capture = () => preparedSubtitleClockInputs(project, episode, paths.timeline, paths.subtitle, undefined)
  await expect(capture()).resolves.toMatchObject({ clockPresent: true })
  const clock = subtitleClockPath(paths.subtitle)
  await rename(clock, clock + '.saved')
  await expect(capture()).rejects.toThrow(missingClock)

  await writePlaceholder(paths.sources, JSON.stringify({ ...document, local_repair_subtitle_clock_required: undefined }))
  const callsBefore = media.calls.length
  const output = join(project, 'candidate.mp4')
  await expect(renderEpisode({ toolkit, settings: resolveSettings(), project, episode,
    timelinePath: paths.timeline, subtitleSrt: paths.subtitle, lastShot: 1, output, force: false,
    sourceQaVerifier: verifiedSourceQaFixture })).rejects.toThrow(missingClock)
  expect(media.calls).toHaveLength(callsBefore)
  expect(await pathExists(output)).toBe(false)
})

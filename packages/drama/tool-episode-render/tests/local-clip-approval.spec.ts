import { copyFile, mkdir, readFile, realpath, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { type Session, SessionId } from '@deepseek-ai/dsh-session'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import { afterEach, expect, it } from 'vitest'
import { verifySelectedSourceReviews } from '../src/approved-sources.ts'
import { fileSha256 } from '../src/cache.ts'
import { createMediaToolkit } from '../src/ffmpeg.ts'
import { resolveSettings } from '../src/index.ts'
import { createLocalClipRepairVerifier, type LocalClipRepairBinding } from '../src/local-clip-evidence.ts'
import { episodePaths, pathExists } from '../src/paths.ts'
import { prepareEpisode, preparedSubtitleClockInputs } from '../src/prepare.ts'
import { renderEpisode } from '../src/render.ts'
import { createSourceQaStagedAccess, type SourceQaStagedAccess } from '../src/source-qa.ts'
import { subtitleClockPath, writeSubtitleClock } from '../src/subtitle-clock.ts'
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

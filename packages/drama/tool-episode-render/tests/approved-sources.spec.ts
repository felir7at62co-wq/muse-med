import { join } from 'node:path'
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { verifySelectedSourceReviews } from '../src/approved-sources.ts'
import { createSourceQaStagedAccess } from '../src/source-qa.ts'
import { fileSha256 } from '../src/cache.ts'
import { episodePaths } from '../src/paths.ts'
import { cleanup, tempProject, writePlaceholder } from './harness.ts'
import { sourceQaFixture, verifiedSourceQaFixture } from './source-qa-fixture.ts'

const projects: string[] = []
afterEach(async () => { await Promise.all(projects.splice(0).map(cleanup)) })

it('rechecks complete package and original evidence through supplied staged file facts', async () => {
  const project = await realpath(await tempProject()); projects.push(project)
  const paths = episodePaths(project, '24'), video = join(project, 'picture.mp4')
  const packagePath = join(project, 'episode_packages', '24', 'package.json')
  const reviewPath = join(project, 'reviews', 'ep24-p01.json')
  const frame = join(project, 'frame.png'), receipt = join(project, 'download.json')
  await Promise.all([writePlaceholder(video, 'picture bytes'), writePlaceholder(frame, 'reviewed image'),
    writePlaceholder(packagePath, JSON.stringify({ episode: '24', video_tasks: [{ shots: [1] }] }))])
  const videoSha256 = await fileSha256(video), qa = await sourceQaFixture(project, video)
  await writePlaceholder(receipt, JSON.stringify({ version: 1, kind: 'video', media_type: 'video/mp4',
    path: video, sha256: `sha256:${videoSha256}`, source_sha256: 'a'.repeat(64) }))
  const checks = Object.fromEntries(['identity', 'wardrobe', 'scene', 'prop', 'action_and_dialogue', 'visible_artifacts',
    'continuity', 'voice_and_speaker', 'av_sync', 'sensitive_content'].map(key => [key, 'pass']))
  await writePlaceholder(reviewPath, JSON.stringify({ episode: '24', package: 1, status: 'approved', subtitle_cleanup: 'not_required',
    package_sha256: await fileSha256(packagePath), video_path: video, video_sha256: videoSha256,
    content_review: { ...checks, embedded_subtitles: 'absent' }, review_frames: [frame],
    original_download_receipt_path: receipt, source_qa: { version: 1, selected: qa.declaration } }))
  const stage = join(project, 'private-stage'); await mkdir(stage)
  const originals = [video, packagePath, reviewPath, frame, receipt, qa.declaration.ocr.path, qa.declaration.inspection.path]
  const files = await Promise.all(originals.map(async (originalPath, index) => {
    const bytes = await readFile(originalPath), stagedPath = join(stage, String(index))
    await copyFile(originalPath, stagedPath)
    return { originalPath, stagedPath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }))
  const signal = new AbortController().signal
  const snapshot = [{ originalPath: join(project, 'reviews'), entries: ['ep24-p01.json'] }]
  const access = createSourceQaStagedAccess(project, stage, files, signal, snapshot)
  const row = { shot: 1, package: 1, video, audio: video }
  const direct = await verifySelectedSourceReviews(paths, [row], true, true, verifiedSourceQaFixture)
  for (const original of [frame, receipt]) {
    expect(direct[0]?.sourceQa?.files).toContainEqual({ path: original, sha256: await fileSha256(original) })
    const saved = await readFile(original)
    await expect(verifySelectedSourceReviews(paths, [row], true, true, async () => {
      await writeFile(original, 'changed while verifying')
    })).rejects.toThrow(/变化/u)
    await writeFile(original, saved)
    const mapped = files.find(file => file.originalPath === original)!
    await expect(verifySelectedSourceReviews(paths, [row], true, true, async () => {
      await writeFile(mapped.stagedPath, 'changed while verifying')
    }, access)).rejects.toThrow(/changed/u)
    await copyFile(original, mapped.stagedPath)
  }
  expect(await verifySelectedSourceReviews(paths, [row], true, true, verifiedSourceQaFixture, access)).toEqual(direct)
  const absent = createSourceQaStagedAccess(project, stage, files.filter(file => file.originalPath !== reviewPath), signal, snapshot)
  await expect(verifySelectedSourceReviews(paths, [row], true, true, verifiedSourceQaFixture, absent))
    .rejects.toThrow('no captured mapping')
  const noSnapshot = createSourceQaStagedAccess(project, stage, files, signal)
  await expect(verifySelectedSourceReviews(paths, [row], true, true, verifiedSourceQaFixture, noSnapshot))
    .rejects.toThrow('no captured directory snapshot')
  await writeFile(files[2]!.stagedPath, 'changed')
  await expect(verifySelectedSourceReviews(paths, [row], true, true, verifiedSourceQaFixture, access)).rejects.toThrow('stage file changed')
})

it('rejects an unrelated independent audio file when the selected picture was not cleaned', async () => {
  const project = await realpath(await tempProject()); projects.push(project)
  const paths = episodePaths(project, '24'), video = join(project, 'picture.mp4'), audio = join(project, 'sound.mp4')
  const packagePath = join(project, 'episode_packages', '24', 'package.json'), reviewPath = join(project, 'reviews', 'ep24-p01.json')
  const frame = join(project, 'frame.png'), receipt = join(project, 'download.json')
  await Promise.all([writePlaceholder(video, 'approved picture'), writePlaceholder(audio, 'unrelated audio'),
    writePlaceholder(frame, 'reviewed image'), writePlaceholder(packagePath, JSON.stringify({ episode: '24', video_tasks: [{ shots: [1] }] }))])
  const videoSha256 = await fileSha256(video), audioSha256 = await fileSha256(audio), qa = await sourceQaFixture(project, video)
  await writePlaceholder(receipt, JSON.stringify({ version: 1, kind: 'video', media_type: 'video/mp4',
    path: video, sha256: `sha256:${videoSha256}`, source_sha256: 'a'.repeat(64) }))
  const checks = Object.fromEntries(['identity', 'wardrobe', 'scene', 'prop', 'action_and_dialogue', 'visible_artifacts',
    'continuity', 'voice_and_speaker', 'av_sync', 'sensitive_content'].map(key => [key, 'pass']))
  await writePlaceholder(reviewPath, JSON.stringify({ episode: '24', package: 1, status: 'approved', subtitle_cleanup: 'not_required',
    package_sha256: await fileSha256(packagePath), video_path: video, video_sha256: videoSha256,
    audio_path: audio, audio_sha256: audioSha256, content_review: { ...checks, embedded_subtitles: 'absent' },
    review_frames: [frame], original_download_receipt_path: receipt, source_qa: { version: 1, selected: qa.declaration } }))
  await expect(verifySelectedSourceReviews(paths, [{ shot: 1, package: 1, video, audio }], true, true, verifiedSourceQaFixture))
    .rejects.toThrow('独立原声音轨缺少可验证的原片复验')
})

it.each([
  { kind: 'original without burned text' },
  { kind: 'verified erase with original sound' },
  { kind: 'manual erase', error: /正式去字幕结果/u },
  { kind: 'local fallback after both routes finished' },
  { kind: 'local fallback while paid route is unknown', error: /明确终态/u },
  { kind: 'local fallback with reused comparison frame', error: /独立的处理前后抽帧/u },
  { kind: 'wrong download bytes', error: /下载回执与本次选片/u },
  { kind: 'edited picture falsely marked unneeded', error: /下载回执与本次选片/u },
  { kind: 'wrong origin for separate sound', error: /下载回执与本次选片/u },
  { kind: 'unverified sensitive content', error: /内容复核不完整/u },
  { kind: 'no frames', error: /缺少审核抽帧/u },
])('requires current package evidence in strict mode: $kind', async ({ kind, error }) => {
  const project = await tempProject()
  projects.push(project)
  const paths = episodePaths(project, '24')
  const packagePath = join(project, 'episode_packages', '24', 'package.json')
  const reviewPath = join(project, 'reviews', 'ep24-p01.json')
  const video = join(project, 'picture.mp4')
  const clean = kind !== 'original without burned text' && kind !== 'edited picture falsely marked unneeded'
  const audio = clean ? join(project, 'original.mp4') : video
  const download = join(project, 'picture-download.json')
  const originalDownload = join(project, 'original-download.json')
  const frame = join(project, 'review-frame.png')
  const originalFrame = join(project, 'original-frame.png')
  await Promise.all([
    writePlaceholder(video, 'current picture bytes'),
    ...(clean ? [writePlaceholder(audio, 'current original sound')] : []),
    writePlaceholder(frame, 'review evidence'),
    writePlaceholder(originalFrame, 'original frame evidence'),
    writePlaceholder(packagePath, JSON.stringify({ episode: '24', video_tasks: [{ shots: [1] }] })),
  ])
  const videoSha256 = await fileSha256(video)
  const selectedQa = await sourceQaFixture(project, video)
  const originalQa = clean ? await sourceQaFixture(project, audio, 'original') : undefined
  const urlDigest = 'a'.repeat(64)
  await writePlaceholder(download, JSON.stringify({ version: 1, kind: 'video', media_type: 'video/mp4', path: video,
    sha256: `sha256:${kind === 'wrong download bytes' ? '0'.repeat(64) : videoSha256}`, source_sha256: urlDigest }))
  await writePlaceholder(originalDownload, JSON.stringify({ version: 1, kind: 'video', media_type: 'video/mp4', path: audio,
    sha256: `sha256:${['edited picture falsely marked unneeded', 'wrong origin for separate sound'].includes(kind)
      ? '0'.repeat(64) : await fileSha256(audio)}`, source_sha256: 'b'.repeat(64) }))
  await writePlaceholder(reviewPath, JSON.stringify({
    episode: '24', package: 1, status: 'approved', subtitle_cleanup: clean ? 'clean' : 'not_required',
    package_sha256: await fileSha256(packagePath), video_path: video, video_sha256: videoSha256,
    audio_path: audio, audio_sha256: await fileSha256(audio),
    original_download_receipt_path: originalDownload,
    review_frames: kind === 'no frames' ? [] : [frame],
    source_qa: { version: 1, selected: selectedQa.declaration,
      ...(originalQa === undefined ? {} : {
        original: originalQa.declaration, affected_intervals: [{ start_seconds: 2, end_seconds: 3 }],
      }) },
    content_review: { identity: 'pass', wardrobe: 'pass', scene: 'pass', prop: 'pass', action_and_dialogue: 'pass',
      visible_artifacts: 'pass', continuity: 'pass', voice_and_speaker: 'pass', av_sync: 'pass', embedded_subtitles: 'absent',
      sensitive_content: kind === 'unverified sensitive content' ? 'pending' : 'pass' },
    ...(kind.startsWith('local fallback') ? { subtitle_erasure: {
      stage: 'local_erase',
      free: { status: 'unavailable', reason: '免费目录没有可用路线' },
      yudian: { status: kind.includes('unknown') ? 'unknown' : 'failed', reason: '测试供应商任务状态' },
      intervals: [{ start_seconds: 2, end_seconds: 3 }],
      original_review_frame: kind.includes('reused') ? frame : originalFrame,
    } } : clean && kind !== 'manual erase' ? { subtitle_erasure: {
      stage: 'erase_subtitle', source_task_id: 629024, operation_task_id: 700001, result_id: 700002,
      output_url_sha256: urlDigest, download_receipt_path: download,
    } } : {}),
  }))
  const row = { shot: 1, package: 1, video, audio }
  const result = verifySelectedSourceReviews(paths, [row], true, true, verifiedSourceQaFixture)
  if (error !== undefined) await expect(result).rejects.toThrow(error)
  else {
    const checked = await result
    expect(checked).toMatchObject([{ shot: 1, videoSha256 }])
    const consumed = [frame, originalDownload,
      ...(kind === 'verified erase with original sound' ? [download] : []),
      ...(kind === 'local fallback after both routes finished' ? [originalFrame] : [])]
    for (const path of consumed) {
      expect(checked[0]?.sourceQa?.files).toContainEqual({ path: await realpath(path), sha256: await fileSha256(path) })
    }
    const saved = await readFile(frame)
    await writeFile(frame, 'changed after verification')
    const canonicalFrame = await realpath(frame)
    const captured = checked[0]?.sourceQa?.files.find(file => file.path === canonicalFrame)
    expect(await fileSha256(frame)).not.toBe(captured?.sha256)
    await writeFile(frame, saved)
  }
  await expect(verifySelectedSourceReviews(paths, [row], true)).resolves.toHaveLength(1)
})

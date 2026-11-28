import { join } from 'node:path'
import { appendFile, copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { verifySelectedSourceReviews } from '../src/approved-sources.ts'
import { createSourceQaStagedAccess, verifySourceQa, type SourceQaEvidenceBinding } from '../src/source-qa.ts'
import * as Cache from '../src/cache.ts'
import { episodePaths } from '../src/paths.ts'
import { cleanup, tempProject, writePlaceholder } from './harness.ts'
import { sourceQaFixture, verifiedSourceQaFixture } from './source-qa-fixture.ts'

const projects: string[] = []
const fileSha256 = Cache.fileSha256
afterEach(async () => { await Promise.all(projects.splice(0).map(cleanup)) })

it('requires both original downloads and current repaired-MOV evidence for a local dialogue repair', async () => {
  const project = await realpath(await tempProject()); projects.push(project)
  const paths = episodePaths(project, '24')
  const video = join(project, 'editing', 'dialogue-patch-24-ABC123', 'clip.mov')
  const packagePath = join(project, 'episode_packages', '24', 'package.json')
  const reviewPath = join(project, 'reviews', 'ep24-p01.json')
  const config = join(project, 'project_config.json'), frame = join(project, 'frame.png')
  const packageDocument = { episode: '24', script_id: 6613, episode_id: 154534,
    video_tasks: [{ shots: [1], index: 1, storyboard_id: 2711188 }] }
  await Promise.all([writePlaceholder(video, 'native repair bytes'), writePlaceholder(frame, 'reviewed image'),
    writePlaceholder(config, JSON.stringify({ jubian_script_id: 6613 })),
    writePlaceholder(packagePath, JSON.stringify(packageDocument))])
  const videoSha256 = await fileSha256(video), qa = await sourceQaFixture(project, video)
  const original = async (name: string, id: number, urlHash: string) => {
    const path = join(project, `${name}.mp4`), receiptPath = join(project, `${name}-download.json`)
    await writePlaceholder(path, name)
    const sha256 = await fileSha256(path)
    await writePlaceholder(receiptPath, JSON.stringify({ version: 1, kind: 'video', media_type: 'video/mp4',
      path, sha256: `sha256:${sha256}`, source_sha256: urlHash }))
    const identity = { task_id: id, subtask_id: id + 10, first_result_id: id + 20 }
    return {
      declaration: { ...identity, source_path: path, source_sha256: sha256, download_receipt_path: receiptPath },
      binding: { ...identity, path, sha256, receiptPath, urlSha256: urlHash },
    }
  }
  const [target, donor] = await Promise.all([original('target', 966450, 'a'.repeat(64)), original('donor', 887973, 'b'.repeat(64))])
  const checks = Object.fromEntries(['identity', 'wardrobe', 'scene', 'prop', 'action_and_dialogue', 'visible_artifacts',
    'continuity', 'voice_and_speaker', 'av_sync', 'sensitive_content'].map(key => [key, 'pass']))
  const id = '5496c6b5-a416-4932-acc7-7d2baa03a932'
  const localPatch = { target: target.declaration, donor: donor.declaration, recheck_evidence_id: id }
  const review = { episode: '24', package: 1, status: 'approved', subtitle_cleanup: 'not_required',
    package_sha256: await fileSha256(packagePath), storyboard_id: 2711188, video_path: video, video_sha256: videoSha256,
    audio_path: video, audio_sha256: videoSha256, local_dialogue_patch: localPatch,
    content_review: { ...checks, embedded_subtitles: 'absent' }, review_frames: [frame],
    source_qa: { version: 1, selected: qa.declaration } }
  const rows = [{ shot: 1, package: 1, video, audio: video }]
  const saveReview = async (updates: object = {}) => {
    await writePlaceholder(reviewPath, JSON.stringify({ ...review, ...updates }))
  }
  const delivered = (verifier?: (binding: SourceQaEvidenceBinding) => Promise<void>) =>
    verifySelectedSourceReviews(paths, rows, true, true, verifier)
  await saveReview({ status: 'needs_review' })
  await expect(verifySelectedSourceReviews(paths, rows)).resolves.toEqual([])
  await expect(delivered(verifiedSourceQaFixture)).rejects.toHaveProperty('code', 'SOURCE_DIALOGUE_PATCH_PENDING')
  await saveReview()
  await expect(verifySelectedSourceReviews(paths, rows, true)).rejects.toHaveProperty('code', 'SOURCE_DIALOGUE_PATCH_PENDING')
  await expect(delivered()).rejects.toThrow('缺少真实OCR')
  await expect(delivered(async () => { throw new Error('missing current Session patch') })).rejects.toThrow('missing current Session patch')
  await expect(verifySourceQa({ project, review, videoPath: video, videoSha256, originalPath: video, originalSha256: videoSha256,
    verifier: verifiedSourceQaFixture })).rejects.toThrow('缺少当前会话的正式修音证据')

  const bindings: SourceQaEvidenceBinding[] = []
  const result = await delivered(async (binding) => { bindings.push(binding) })
  expect(bindings.map(binding => binding.localDialoguePatch)).toEqual([{
    project, episode: '24', output: video, sha256: videoSha256, scriptId: 6613, episodeId: 154534,
    storyboardId: 2711188, recheckEvidenceId: id, originals: { target: target.binding, donor: donor.binding },
  }])
  expect(result[0]?.requiresLocalDialoguePatch).toBe(true)
  const files = [video, config, packagePath, target.binding.path, target.binding.receiptPath, donor.binding.path, donor.binding.receiptPath]
  for (const path of files) {
    expect(result[0]?.sourceQa?.files).toContainEqual({ path, sha256: await fileSha256(path) })
  }
  for (const invalid of [{ local_dialogue_patch: undefined }, { storyboard_id: 2711187 }, { subtitle_cleanup: 'clean' },
    { local_dialogue_patch: { ...localPatch, recheck_evidence_id: undefined } },
    { local_dialogue_patch: { ...localPatch, donor: target.declaration } }]) {
    await saveReview(invalid)
    await expect(delivered(verifiedSourceQaFixture)).rejects.toHaveProperty('code', 'SOURCE_DIALOGUE_PATCH_PENDING')
  }
  await saveReview()
  await writeFile(donor.binding.receiptPath, JSON.stringify({ version: 1, kind: 'video', media_type: 'video/mp4',
    path: donor.binding.path, sha256: `sha256:${target.binding.sha256}`, source_sha256: donor.binding.urlSha256 }))
  await expect(delivered(verifiedSourceQaFixture)).rejects.toThrow('正式下载回执')
})

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
  await expect(verifySelectedSourceReviews({ ...paths, project: join(project, 'another-project') }, [row],
    true, true, verifiedSourceQaFixture, access)).rejects.toThrow('stage belongs to another project')
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

it('refuses one review frame bound with two digests during content verification', async () => {
  const project = await realpath(await tempProject()); projects.push(project)
  const paths = episodePaths(project, '24'), video = join(project, 'picture.mp4')
  const packagePath = join(project, 'episode_packages', '24', 'package.json')
  const reviewPath = join(project, 'reviews', 'ep24-p01.json')
  const frame = join(project, 'review-frame.png'), receipt = join(project, 'download.json')
  await Promise.all([writePlaceholder(video, 'approved picture'),
    writePlaceholder(frame, 'reviewed frame'),
    writePlaceholder(packagePath, JSON.stringify({ episode: '24', video_tasks: [{ shots: [1] }] }))])
  const videoSha256 = await fileSha256(video), qa = await sourceQaFixture(project, video)
  await writePlaceholder(receipt, JSON.stringify({ version: 1, kind: 'video', media_type: 'video/mp4', path: video,
    sha256: `sha256:${videoSha256}`, source_sha256: 'a'.repeat(64) }))
  const checks = Object.fromEntries(['identity', 'wardrobe', 'scene', 'prop', 'action_and_dialogue', 'visible_artifacts',
    'continuity', 'voice_and_speaker', 'av_sync', 'sensitive_content'].map(key => [key, 'pass']))
  await writePlaceholder(reviewPath, JSON.stringify({ episode: '24', package: 1, status: 'approved', subtitle_cleanup: 'not_required',
    package_sha256: await fileSha256(packagePath), video_path: video, video_sha256: videoSha256, audio_path: video,
    audio_sha256: videoSha256, content_review: { ...checks, embedded_subtitles: 'absent' },
    review_frames: [frame, frame],
    original_download_receipt_path: receipt, source_qa: { version: 1, selected: qa.declaration } }))
  // Change the actual file after the first digest so the next binding observes different bytes.
  let frameReads = 0
  const hash = vi.spyOn(Cache, 'fileSha256').mockImplementation(async (path) => {
    const sha256 = await fileSha256(path)
    if (path === frame) {
      frameReads += 1
      if (frameReads === 1) await appendFile(frame, ' changed')
    }
    return sha256
  })
  try {
    await expect(verifySelectedSourceReviews(paths, [{ shot: 1, package: 1, video, audio: video }], true, true, verifiedSourceQaFixture))
      .rejects.toThrow('审核证据在核验期间已变化')
    expect(frameReads).toBe(2)
  } finally { hash.mockRestore() }
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
  { kind: 'local fallback from captured copies' },
  { kind: 'local fallback while paid route is unknown', error: /明确终态/u },
  { kind: 'local fallback with reused comparison frame', error: /独立的处理前后抽帧/u },
  { kind: 'wrong download bytes', error: /下载回执与本次选片/u },
  { kind: 'edited picture falsely marked unneeded', error: /下载回执与本次选片/u },
  { kind: 'wrong origin for separate sound', error: /下载回执与本次选片/u },
  { kind: 'unverified sensitive content', error: /内容复核不完整/u },
  { kind: 'no frames', error: /缺少审核抽帧/u },
])('requires current package evidence in strict mode: $kind', async ({ kind, error }) => {
  const project = await realpath(await tempProject())
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
    if (kind === 'local fallback from captured copies') {
      const stage = join(project, 'private-stage')
      await mkdir(stage)
      const originals = [...new Set([video, audio, packagePath, reviewPath,
        ...checked.flatMap(shot => shot.sourceQa?.files.map(file => file.path) ?? [])])]
      const files = await Promise.all(originals.map(async (originalPath, index) => {
        const bytes = await readFile(originalPath), stagedPath = join(stage, String(index))
        await copyFile(originalPath, stagedPath)
        return { originalPath, stagedPath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      }))
      const access = createSourceQaStagedAccess(project, stage, files, new AbortController().signal,
        [{ originalPath: join(project, 'reviews'), entries: ['ep24-p01.json'] }])
      await expect(verifySelectedSourceReviews(paths, [row], true, true, verifiedSourceQaFixture, access)).resolves.toEqual(checked)
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

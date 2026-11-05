import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { verifySelectedSourceReviews } from '../src/approved-sources.ts'
import { fileSha256 } from '../src/cache.ts'
import { episodePaths } from '../src/paths.ts'
import { cleanup, tempProject, writePlaceholder } from './harness.ts'

const projects: string[] = []
afterEach(async () => { await Promise.all(projects.splice(0).map(cleanup)) })

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
  const result = verifySelectedSourceReviews(paths, [row], true, true)
  if (error !== undefined) await expect(result).rejects.toThrow(error)
  else await expect(result).resolves.toMatchObject([{ shot: 1, videoSha256 }])
  await expect(verifySelectedSourceReviews(paths, [row], true)).resolves.toHaveLength(1)
})

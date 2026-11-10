import { join } from 'node:path'
import { rename } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { verifySelectedSourceReviews } from '../src/approved-sources.ts'
import { fileSha256 } from '../src/cache.ts'
import { episodePaths } from '../src/paths.ts'
import { cleanup, tempProject, writePlaceholder } from './harness.ts'
import { sourceQaFixture, verifiedSourceQaFixture } from './source-qa-fixture.ts'

const projects: string[] = []
afterEach(async () => { await Promise.all(projects.splice(0).map(cleanup)) })

async function fixture() {
  const project = await tempProject()
  projects.push(project)
  const paths = episodePaths(project, '24')
  const video = join(project, 'picture.mp4'), reviewPath = join(project, 'reviews', 'ep24-p01.json')
  const packagePath = join(project, 'episode_packages', '24', 'package.json')
  const frame = join(project, 'frame.png'), download = join(project, 'download.json')
  await writePlaceholder(video, 'selected picture and sound')
  await writePlaceholder(frame, 'one actual review artifact')
  await writePlaceholder(packagePath, JSON.stringify({ episode: '24', video_tasks: [{ shots: [1] }] }))
  const selected = await sourceQaFixture(project, video)
  const videoSha256 = await fileSha256(video)
  await writePlaceholder(download, JSON.stringify({ version: 1, kind: 'video', media_type: 'video/mp4', path: video,
    sha256: `sha256:${videoSha256}`, source_sha256: 'a'.repeat(64) }))
  const review: Record<string, unknown> = { episode: '24', package: 1, status: 'approved', subtitle_cleanup: 'not_required',
    package_sha256: await fileSha256(packagePath), video_path: video, video_sha256: videoSha256,
    original_download_receipt_path: download, review_frames: [frame],
    content_review: { identity: 'pass', wardrobe: 'pass', scene: 'pass', prop: 'pass', action_and_dialogue: 'pass',
      visible_artifacts: 'pass', continuity: 'pass', voice_and_speaker: 'pass', av_sync: 'pass', sensitive_content: 'pass', embedded_subtitles: 'absent' },
    source_qa: { version: 1, selected: selected.declaration } }
  const save = () => writePlaceholder(reviewPath, JSON.stringify(review))
  await save()
  return { project, paths, video, reviewPath, packagePath, review, frame, save, row: { shot: 1, package: 1, video, audio: video } }
}

it.each(['non-object record', 'wrong episode', 'wrong package', 'old package digest', 'unknown cleanup', 'changed video'] as const)
('rejects a stale or malformed saved approval: %s', async (kind) => {
  const f = await fixture()
  if (kind === 'wrong episode') f.review.episode = '25'
  if (kind === 'wrong package') f.review.package = 2
  if (kind === 'old package digest') f.review.package_sha256 = 'b'.repeat(64)
  if (kind === 'unknown cleanup') f.review.subtitle_cleanup = 'pending'
  if (kind === 'changed video') await writePlaceholder(f.video, 'replaced source of the same episode')
  await f.save()
  if (kind === 'non-object record') await writePlaceholder(f.reviewPath, '[]')
  await expect(verifySelectedSourceReviews(f.paths, [f.row], true)).rejects.toThrow(kind === 'non-object record'
    ? /不是 JSON 对象/u : kind === 'changed video' ? /所选画面字节/u : /审核集号、包号、分包版本/u)
})

it('accepts a numeric episode identity and ignores non-review files without losing a valid package', async () => {
  const f = await fixture()
  f.review.episode = 24
  await f.save()
  await writePlaceholder(join(f.project, 'reviews', 'notes.json'), 'not an approval')
  await expect(verifySelectedSourceReviews(f.paths, [f.row], true)).resolves.toHaveLength(1)
})

it.each(['ep24-p001.json', 'ep24-p99999999999999999999.json'])('rejects ambiguous package numbering in %s', async (name) => {
  const f = await fixture()
  await rename(f.reviewPath, join(f.project, 'reviews', name))
  await expect(verifySelectedSourceReviews(f.paths, [f.row], true)).rejects.toThrow(/审核包号或文件名无效/u)
})

it('surfaces an unreadable review directory instead of treating an IO failure as no approvals', async () => {
  const f = await fixture()
  await rename(join(f.project, 'reviews'), join(f.project, 'saved-reviews'))
  await writePlaceholder(join(f.project, 'reviews'), 'a file where a directory is required')
  await expect(verifySelectedSourceReviews(f.paths, [f.row], true)).rejects.toThrow()
})

it.each(['missing frame path', 'project root', 'outside frame'] as const)
('rejects non-project review artifacts: %s', async (kind) => {
  const f = await fixture()
  let frame = ''
  if (kind === 'project root') frame = f.project
  if (kind === 'outside frame') {
    const outside = await tempProject()
    projects.push(outside)
    frame = join(outside, 'frame.png')
    await writePlaceholder(frame, 'outside the owning project')
  }
  f.review.review_frames = [frame]
  await f.save()
  await expect(verifySelectedSourceReviews(f.paths, [f.row], true, true, verifiedSourceQaFixture)).rejects.toThrow(
    kind === 'missing frame path' ? /缺少审核证据文件/u : /必须是项目内的文件/u)
})

it('keeps an unreviewed separate sound available for a working preview while refusing formal delivery', async () => {
  const f = await fixture()
  const audio = join(f.project, 'separate-original.mp4')
  await writePlaceholder(audio, 'working unreviewed separate sound')
  const row = { ...f.row, audio }
  const preview = await verifySelectedSourceReviews(f.paths, [row], false, true, verifiedSourceQaFixture)
  expect(preview).toHaveLength(1)
  expect(preview[0]).not.toHaveProperty('audioSha256')
  expect(preview[0]!.sourceQa).toHaveProperty('sha256')
  await expect(verifySelectedSourceReviews(f.paths, [row], true, true, verifiedSourceQaFixture)).rejects.toThrow(/缺少已审核的独立原声/u)
})

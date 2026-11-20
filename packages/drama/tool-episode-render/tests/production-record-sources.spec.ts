/** Production source lists still require independent, current media reviews. */
import { join } from 'node:path'
import { readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { verifySelectedSourceReviews } from '../src/approved-sources.ts'
import { fileSha256 } from '../src/cache.ts'
import { episodePaths } from '../src/paths.ts'
import { cleanup, tempProject, writePlaceholder } from './harness.ts'
import { sourceQaFixture, verifiedSourceQaFixture } from './source-qa-fixture.ts'

const projects: string[] = []
afterEach(async () => { await Promise.all(projects.splice(0).map(cleanup)) })

async function fixture() {
  const project = await realpath(await tempProject()); projects.push(project)
  const paths = episodePaths(project, '24')
  const video = join(project, 'provider-original.mp4'), frame = join(project, 'observed.png')
  const packagePath = join(project, 'episode_packages', '24', 'package.json')
  const reviewPath = join(project, 'reviews', 'ep24-p01.json'), receipt = join(project, 'download.json')
  const manifest = { operation: 'muse_production', version: 1, mode: 'advisory', media_acceptance: false, episode: '24',
    video_tasks: [{ index: 1, shots: [1], storyboard_id: 10000 }] }
  await Promise.all([writePlaceholder(video, 'original provider media'), writePlaceholder(frame, 'observed picture'),
    writePlaceholder(packagePath, JSON.stringify(manifest))])
  const videoSha256 = await fileSha256(video), qa = await sourceQaFixture(project, video)
  await writePlaceholder(receipt, JSON.stringify({ version: 1, kind: 'video', media_type: 'video/mp4', path: video,
    sha256: `sha256:${videoSha256}`, source_sha256: 'a'.repeat(64) }))
  const checks = Object.fromEntries(['identity', 'wardrobe', 'scene', 'prop', 'action_and_dialogue', 'visible_artifacts',
    'continuity', 'voice_and_speaker', 'av_sync', 'sensitive_content'].map(key => [key, 'pass']))
  const review = { episode: '24', package: 1, status: 'approved', subtitle_cleanup: 'not_required',
    package_sha256: await fileSha256(packagePath), video_path: video, video_sha256: videoSha256,
    content_review: { ...checks, embedded_subtitles: 'absent' }, review_frames: [frame],
    original_download_receipt_path: receipt, source_qa: { version: 1, selected: qa.declaration } }
  await writePlaceholder(reviewPath, JSON.stringify(review))
  return { paths, video, packagePath, reviewPath, manifest, review, videoSha256,
    row: { shot: 1, package: 1, video, audio: video } }
}

it('consumes a production source list and invalidates its earlier review after the list changes', async () => {
  const f = await fixture()
  await expect(verifySelectedSourceReviews(f.paths, [f.row], true, true, verifiedSourceQaFixture))
    .resolves.toMatchObject([{ shot: 1, videoSha256: f.videoSha256 }])
  await writeFile(f.packagePath, JSON.stringify({ ...f.manifest, plan_fingerprint: 'b'.repeat(64) }))
  await expect(verifySelectedSourceReviews(f.paths, [f.row], true, true, verifiedSourceQaFixture))
    .rejects.toThrow(/分包版本/u)
})

it('does not treat a saved production source list as approved media', async () => {
  const f = await fixture()
  await rm(f.reviewPath)
  await expect(verifySelectedSourceReviews(f.paths, [f.row], true, true, verifiedSourceQaFixture))
    .rejects.toThrow(/缺少本集选源审核/u)
})

it('retains speaker checks and current Host evidence for production source lists', async () => {
  const f = await fixture(), saved = await readFile(f.reviewPath)
  await writeFile(f.reviewPath, JSON.stringify({ ...f.review,
    content_review: { ...f.review.content_review, voice_and_speaker: 'pending' } }))
  await expect(verifySelectedSourceReviews(f.paths, [f.row], true, true, verifiedSourceQaFixture))
    .rejects.toThrow(/内容复核不完整/u)
  await writeFile(f.reviewPath, saved)
  await expect(verifySelectedSourceReviews(f.paths, [f.row], true, true))
    .rejects.toThrow(/缺少真实OCR执行和审看记录核验/u)
})

it('requires every original production package when only one package needed rework', async () => {
  const f = await fixture()
  await writeFile(f.packagePath, JSON.stringify({ ...f.manifest,
    video_tasks: [...f.manifest.video_tasks, { index: 2, shots: [2], storyboard_id: 10001 }] }))
  await writeFile(f.reviewPath, JSON.stringify({ ...f.review, package_sha256: await fileSha256(f.packagePath) }))
  await expect(verifySelectedSourceReviews(f.paths, [f.row], true, true, verifiedSourceQaFixture))
    .rejects.toThrow(/没有覆盖本集编译分包/u)
})
